const { ethers } = require("ethers");
require("dotenv").config();
const axios = require("axios").default;
const CH_ABI = require("./abi/ClearingHouse.json");
const ERC20_ABI = require("./abi/ERC20.json");
const AMM_ABI = require("./abi/AMMRouter.json");
const fs = require("fs");
const fetch = require('node-fetch');

const API_URL = process.env.API_URL;

let provider = new ethers.providers.AlchemyProvider(
    process.env.NETWORK,
    process.env.ALCHEMY_KEY
);

let signer = new ethers.Wallet(process.env.LIQUIDATOR_KEY, provider);

let ACTIVE_LP_POSITIONS = {};
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

async function attemptLiquidationMaker(amm, maker){
    let amm_contract = new ethers.Contract(amm, AMM_ABI['abi'], signer);
    try {
        let isLiquidatable = await amm_contract.isMakerLiquidatable(maker)

        if (isLiquidatable){
            await contract.liquidateMaker(amm, maker);
        }

    } catch (error) {
        let blockNumber = await provider.getBlockNumber();
        console.error(`Failed to liquidate maker ${maker} in ${amm}, block number: ${blockNumber}, ${error}, liquidatable status: ${await amm_contract.isMakerLiquidatable(maker)}`);

        await fetch(process.env.SLACK_WEBHOOK_URL_ORACLE_DEVIATION, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              blocks: [
                {
                  type: 'header',
                  text: {
                    type: 'plain_text',
                    text: ':exclamation: Liquidation Alert',
                    emoji: true,
                  },
                },
                {
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: `Failed to liquidate maker ${maker} in ${amm}, block number: ${blockNumber}`,
                  },
                },
              ],
            }),
          })      
    }
}

async function attemptLiquidation(amm, trader) {
    try {
        let isLiquidatable = await contract.isLiquidatable(amm, trader)
        if (isLiquidatable) {
            await contract.liquidate(amm, trader);
            
            let index = ACTIVE_POSITIONS[amm].indexOf(trader);

            if (index > -1) {
                ACTIVE_POSITIONS[amm].splice(index, 1);
            }
        }

    } catch (error) {

            if (process.env.SLACK_WEBHOOK_URL_ORACLE_DEVIATION) {
                await fetch(process.env.SLACK_WEBHOOK_URL_ORACLE_DEVIATION, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      blocks: [
                        {
                          type: 'header',
                          text: {
                            type: 'plain_text',
                            text: ':exclamation: Liquidation Alert',
                            emoji: true,
                          },
                        },
                        {
                          type: 'section',
                          text: {
                            type: 'mrkdwn',
                            text: `Failed to liquidate ${trader} in ${amm}, block number: ${blockNumber}`,
                          },
                        },
                      ],
                    }),
                  })
            }
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
                allLiquidations.push(() => attemptLiquidation(amm, trader));
            }
        }

        while (allLiquidations.length > 0) {
            const currentBatch = allLiquidations.splice(0, AT_ONCE);
            const currentPromises = currentBatch.map(func => func());
            await Promise.all(currentPromises);
        }

        let allMakerLiquidations = [];

        for (const amm in ACTIVE_LP_POSITIONS) {
            for (const t in ACTIVE_LP_POSITIONS[amm]) {
                let maker = ACTIVE_LP_POSITIONS[amm][t]
                allMakerLiquidations.push(() => attemptLiquidationMaker(amm, maker));
            }
        }

        while (allMakerLiquidations.length > 0) {
            const currentBatch2 = allMakerLiquidations.splice(0, AT_ONCE);
            const currentPromises2 = currentBatch2.map(func => func());
            await Promise.all(currentPromises2);
        }

    } catch (error) {
        console.log(error)
    } finally {
        isRunning = false;
    }
}

async function fetchAllTraders() {
    const baseURL = `${API_URL}/leaderboard/trade`;
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
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
            console.error("Error fetching data:", error);
            break;
        }
    }

    return allTraders;
}

async function fetchAllLPs() {
    const baseURL = `${API_URL}/liquidity`;
    const pageSize = 1000; 
    let allLPs = [];
    let page = 1;
    const notionals = {};

    const { data: { data: { amms } } } = await axios.get(`${API_URL}/contracts`);
    const ammAddresses = Object.values(amms);
    ammAddresses.forEach(amm => {
        notionals[amm] = {};
    });

    while (true) {
        try {
            const response = await axios.get(baseURL, {
                params: {
                    page: page,
                    pageSize: pageSize
                }
            });

            if (response.data.status === "success") {
                //loop thrue responses.data.data

                for (let i = 0; i < response.data.data.result.length; i++) {
                    let lp = response.data.data.result[i];

                    if (!notionals[lp.amm][lp.maker]) {
                        notionals[lp.amm][lp.maker] = 0;
                    }
                    notionals[lp.amm][lp.maker] += Number(lp.notionalExchanged);
                }
                   
                const lps = response.data.data.result.map(item => item.maker);
                allLPs.push(...lps);

                if (lps.length < pageSize || allLPs.length >= response.data.data.totalCount) {
                    break;
                }

                page++;
            } else {
                console.error("Failed to fetch data for page", page);
                break;
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
            console.error("Error fetching data:", error);
            break;
        }
    }

    for (const amm in notionals) {
        ACTIVE_LP_POSITIONS[amm] = [];
        for (const maker in notionals[amm]) {
            if (notionals[amm][maker] > 0.0000001) {    // float math issue, set a threshold
                ACTIVE_LP_POSITIONS[amm].push(maker);
            }
        }
    }
}


async function liquidation(){
    let res = await axios.get(`${API_URL}/contracts`);
    let CH_ADDY = res.data.data.clearingHouse;
    console.log(CH_ADDY)
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
    }

    await fetchAllLPs()

    contract.on('PositionChanged', async (amm, trader, margin, size, openNotional, exchangedQuote, exchangedBase, realizedPnL, fundingPayment, markPrice, tradeType, event) => {
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

    contract.on("LiquidityAdded", (amm, maker) => {
        if (!ACTIVE_LP_POSITIONS[amm]) {
            ACTIVE_LP_POSITIONS[amm] = [];
        }

        if (!ACTIVE_LP_POSITIONS[amm].includes(maker)) {
            ACTIVE_LP_POSITIONS[amm].push(maker);
        }
    });

    contract.on("LiquidityRemoved", async (amm, maker) => {
        let amm_contract =  new ethers.Contract(amm, AMM_ABI['abi'], signer);
        let position = await amm_contract.getMakerPositionData(maker);

        if (position.share){
            if (position.share.eq(0)){
                let index = ACTIVE_LP_POSITIONS[amm].indexOf(maker);
                if (index > -1) {
                    ACTIVE_LP_POSITIONS[amm].splice(index, 1);
                }
            }
        }


    });

    //run performLiquidation every minute
    while (true){
        // wait 1 minute
        await new Promise(r => setTimeout(r, 60000));

        if (isRunning == false){
            
            try{
                await performLiquidation(contract)            
            } catch (error) {
                console.log(error)
            }
        }
    };

}

liquidation()