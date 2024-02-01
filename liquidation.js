const { ethers } = require("ethers");
require("dotenv").config();
const axios = require("axios").default;
const CH_ABI = require("./abi/ClearingHouse.json");
const ERC20_ABI = require("./abi/ERC20.json");
const AMM_ABI = require("./abi/AMM.json");
const fs = require("fs");

let provider = new ethers.providers.AlchemyProvider(
    process.env.NETWORK,
    process.env.ALCHEMY_KEY
);

let signer = new ethers.Wallet(process.env.LIQUIDATOR_KEY, provider);

let ACTIVE_POSITIONS = {};
let AT_ONCE = 10;

async function getActivePositionsForAmm(contract, amm, traders) {
    const activeTraders = [];

    function chunkArray(array, size) {
        const result = [];
        for (let i = 0; i < array.length; i += size) {
            result.push(array.slice(i, i + size));
        }
        return result;
    }

    const traderChunks = chunkArray(traders, AT_ONCE);

    for (const chunk of traderChunks) {
        const positionsPromises = chunk.map(trader => contract.getPosition(amm, trader));
        const positions = await Promise.all(positionsPromises);

        for (let i = 0; i < chunk.length; i++) {
            if (positions[i].size != 0) {
                activeTraders.push(chunk[i]);
            }
        }
    }
    return activeTraders;
}

let isRunning = false;

function getConfig(){
    const configData = fs.readFileSync('config.json', 'utf8');
    let config = JSON.parse(configData);
    return config
}

async function getExposure(contract, signer, addy){
    let position = await contract.getPosition(addy, signer.address);

    let amm_contract = new ethers.Contract(addy, AMM_ABI['abi'], signer);
    let mark_price = ethers.utils.formatEther(await amm_contract.getMarkPrice())
    let ethAmount = ethers.utils.formatEther(position.size);
    let total_exposure = Math.abs(ethAmount * mark_price)
    return [position, total_exposure]
}

async function processSingleSellForAmm(contract, signer, addy, amm) {
    try {
        let [position, total_exposure] = await getExposure(contract, signer, addy);
        
        if (position.size != 0){
            let config = getConfig();
            
            let [position, current_exposure] = await getExposure(contract, signer, addy);
            if (current_exposure > config.SELL_ONCE){
                let trade_side = position.size > 0 ? 1 : 0;
                let failed = true;
                for (let i = 0; i < 5; i++){
                    try{
                        await contract.openPosition(addy, trade_side, ethers.utils.parseEther(String(config.SELL_ONCE)), ethers.utils.parseEther('1'), 0);
                        console.log(`Sold ${config.SELL_ONCE} ETH of ${amm}. Current Exposure is ${current_exposure} ETH`);
                        failed = false;
                        break;
                    } catch (error) {
                        await new Promise(r => setTimeout(r, 3000));
                    }
                }

                if (failed){
                    let blockNumber = await provider.getBlockNumber();

                    console.log(`Failed to sell ${amm} at blockNumber ${blockNumber}`)
                    console.log(addy, trade_side, ethers.utils.parseEther(String(config.SELL_ONCE)), ethers.utils.parseEther('1'), 0)
                }
               
            } else {
            }
        }
    } catch (error) {
        console.log("Error in processing single sell for AMM", amm, error);
    }
}

async function twapOut(){

    let res = await axios.get("https://api.nftperp.xyz/contracts");
    let CH_ADDY = res.data.data.clearingHouse;
    let contract = new ethers.Contract(CH_ADDY, CH_ABI['abi'], signer);

    while(true) { 
        let config = getConfig();
        
        for (let amm in res.data.data.amms){
            let addy = res.data.data.amms[amm];
            await processSingleSellForAmm(contract, signer, addy, amm); 
            await new Promise(r => setTimeout(r, 3000));
        }

        await new Promise(r => setTimeout(r, config.REST_TIME * 1000));
    }
}

function absBigNumber(bigNumber) {
    if (bigNumber.isNegative()) {
        return bigNumber.mul(ethers.BigNumber.from("-1"));
    }
    return bigNumber;
}

async function attemptLiquidation(amm, trader, contract, signer) {
    try {
        let isLiquidatable = await contract.isLiquidatable(amm, trader)
        if (isLiquidatable) {
            let amm_contract = new ethers.Contract(amm, AMM_ABI['abi'], signer);
            let position = await contract.getPosition(amm, trader);
            let liquidationPrice = await amm_contract.getLiquidationPrice();
            let positionNotional = position.size.mul(liquidationPrice).div(ethers.utils.parseEther('1'));
            await contract.liquidate(amm, absBigNumber(position.size), trader, absBigNumber(positionNotional));
            let index = ACTIVE_POSITIONS[amm].indexOf(trader);
            if (index > -1) {
                ACTIVE_POSITIONS[amm].splice(index, 1);
            }
        }
    } catch (error) {
        let blockNumber = await provider.getBlockNumber();
        console.error(`Failed to liquidate ${trader} in ${amm}, block number: ${blockNumber}, liquidatable status: ${await contract.isLiquidatable(amm, trader)}`);
    }
}


async function performLiquidation(contract) {
    try {
        //wait random second between 0 to 0.5 to prevent concurrency
        await new Promise(r => setTimeout(r, Math.random() * 500));
        
        if(isRunning) {
            return;
        }

        isRunning = true;

        let allLiquidations = [];

        for (const amm in ACTIVE_POSITIONS) {
            for (const t in ACTIVE_POSITIONS[amm]) {
                let trader = ACTIVE_POSITIONS[amm][t]
                allLiquidations.push(() => attemptLiquidation(amm, trader, contract, signer));
            }
        }

        while (allLiquidations.length > 0) {
            const currentBatch = allLiquidations.splice(0, AT_ONCE);
            const currentPromises = currentBatch.map(func => func());
            await Promise.all(currentPromises);
        }

    } catch (error) {
        console.log(error)
    } finally {
        isRunning = false;
    }
}

async function fetchAllTraders() {
    const baseURL = 'https://api.nftperp.xyz/leaderboard/trade';
    const pageSize = 1000; 
    let allTraders = [];
    let page = 1;

    while (true) {
        try {
            const response = await axios.get(baseURL, {
                params: {
                    page: page,
                    pageSize: pageSize
                }
            });

            if (response.data.status === "success") {
                const traders = response.data.data.result.map(item => item.trader);
                allTraders.push(...traders);

                if (traders.length < pageSize || allTraders.length >= response.data.data.totalCount) {
                    break;
                }

                page++;
            } else {
                console.error("Failed to fetch data for page", page);
                break;
            }
        } catch (error) {
            console.error("Error fetching data:", error);
            break;
        }
    }

    return allTraders;
}


async function liquidation(){
    let res = await axios.get("https://api.nftperp.xyz/contracts");
    let CH_ADDY = res.data.data.clearingHouse;

    let contract = new ethers.Contract(CH_ADDY, CH_ABI['abi'], signer);
   
    let weth_contract = new ethers.Contract(res.data.data.weth, ERC20_ABI['abi'], signer);
    const allowance = await weth_contract.allowance(signer.address, CH_ADDY);

    if (allowance.lt(ethers.utils.parseEther('1000'))) {
        await weth_contract.approve(CH_ADDY, ethers.constants.MaxUint256);
    }


    
    let traders = await fetchAllTraders()

    for (let amm in res.data.data.amms){
        let AMM_ADDY = res.data.data.amms[amm]
        let curr_positions = await getActivePositionsForAmm(contract, AMM_ADDY, traders);
        ACTIVE_POSITIONS[AMM_ADDY] = curr_positions
        console.log(curr_positions)
    }

    contract.on('PositionChanged', async (amm, trader, margin, size, exchangedQuote, exchangedBase, realizedPnL, fundingPayment, markPrice, ifFee, ammFee, limitFee, liquidatorFee, keeperFee, tradeType, event) => {
        const position = await contract.getPosition(amm, trader);
        
        if (position.size != 0){
            if (!ACTIVE_POSITIONS[amm].includes(trader)) {
                ACTIVE_POSITIONS[amm].push(trader);
            }
        }  else {
            let index = ACTIVE_POSITIONS[amm].indexOf(trader);
            if (index > -1) {
                ACTIVE_POSITIONS[amm].splice(index, 1);
            }
        }

        if (isRunning == false){
            await performLiquidation(contract)
        }
    });  

    //run performLiquidation every minute
    while (true){
        // wait 1 minute
        await new Promise(r => setTimeout(r, 60000));

        if (isRunning == false){
            console.log("Running trigger because of minute wait")
            
            try{
                await performLiquidation(contract)            
            } catch (error) {
                console.log(error)
            }
        }
    };

}

twapOut()
liquidation()