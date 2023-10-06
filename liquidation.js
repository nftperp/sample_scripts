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

async function getActivePositionsForAmm(contract, amm, traders) {
    const activeTraders = [];

    for (const trader of traders) {
        const position = await contract.getPosition(amm, trader);
        if (position.size != 0) {
            activeTraders.push(trader);
        }
    }

    if (activeTraders.length > 0) {
        ACTIVE_POSITIONS[amm] = activeTraders;
    }
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
                console.log(`Not enough exposure to sell ${config.SELL_ONCE} ETH of ${amm}. Total Exposure was ${total_exposure}, Current Exposure is ${current_exposure}`);
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
            console.log(`Successfully liquidated ${trader} in ${amm}`);
        }
    } catch (error) {
        let blockNumber = await provider.getBlockNumber();
        console.error(`Failed to liquidate ${trader} in ${amm}, block number: ${blockNumber}, liquidatable status: ${await contract.isLiquidatable(amm, trader)}`);
    }
}


async function performLiquidation(contract){
    try{
        //wait random second between 0 to 0.5 to preven concurrency
        await new Promise(r => setTimeout(r, Math.random() * 500));
        if(isRunning) {
            return;
        }
        console.log("Performing liquidations")

        isRunning = true;

        const liquidationPromises = [];

        //loop thru now to look at liquidation
        for (const amm in ACTIVE_POSITIONS) {
            for (const t in ACTIVE_POSITIONS[amm]) {
                let trader = ACTIVE_POSITIONS[amm][t]
                liquidationPromises.push(attemptLiquidation(amm, trader, contract, signer));
            }
        }

        await Promise.all(liquidationPromises);

    } catch (error) {
        console.log(error)
    } finally {
        isRunning = false;
    }
}

async function fetchAllTraders() {
    const baseURL = 'https://api.nftperp.xyz/leaderboard';
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
    const promises = Object.entries(res.data.data.amms).map(([ammName, ammAddress]) => 
        getActivePositionsForAmm(contract, ammAddress, traders)
    );

    await Promise.all(promises);


    contract.on('PositionChanged', async (amm, trader, openNotional, size, exchangedQuote, exchangedSize, realizedPnL, fundingPayment, markPrice, ifFee, ammFee, limitFee, keeperFee, event) => {

        const position = await contract.getPosition(amm, trader);
        
        if (position.size != 0){
            if (!ACTIVE_POSITIONS[amm].includes(trader)) {
                ACTIVE_POSITIONS[amm].push(trader);
            } else {
                let index = ACTIVE_POSITIONS[amm].indexOf(trader);
                if (index > -1) {
                    ACTIVE_POSITIONS[amm].splice(index, 1);
                }
            }
        }

        if (isRunning == false){
            await performLiquidation(contract)
        }
    });  

    await performLiquidation(contract);

}

twapOut()
liquidation()