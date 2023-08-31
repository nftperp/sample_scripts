const { ethers } = require("ethers");
const axios = require("axios").default;
require("dotenv").config();

const CH_ABI = require("./abi/ClearingHouse.json");

let provider = new ethers.AlchemyProvider(
    process.env.NETWORK,
    process.env.ALCHEMY_KEY
);

let signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const tradersByAmm = {};

async function updateTrader(trader, amm, size){
    if (!tradersByAmm[amm]) {
        tradersByAmm[amm] = {};
    }
  
    if (!tradersByAmm[amm][trader]) {
        tradersByAmm[amm][trader] = 0;
    }

    tradersByAmm[amm][trader] += size;

    if (tradersByAmm[amm][trader] < Math.abs(0.001)){ //conversion issues
        delete tradersByAmm[amm][trader];
    }
}

async function getAllTrades(amm) {
    let allTrades = [];
    let page = 1;
    const pageSize = 1000; 
  
    while (true) {
      const url = `https://api.nftperp.xyz/marketTrades?amm=${amm}&page=${page}&pageSize=${pageSize}&sort=asc`;
      const response = await axios.get(url);
  
      const trades = response.data.data.result;
      if (trades.length === 0) {
        break;
      }
  
      allTrades = allTrades.concat(trades);
  
      if (trades.length < pageSize) {
        break;
      }
  
      page++;
    }
  
    return allTrades;
}


async function main(){
    let res = await axios.get("https://api.nftperp.xyz/contracts");
    let CH_ADDY = res.data.data.clearingHouse;

    let contract = new ethers.Contract(CH_ADDY, CH_ABI['abi'], signer);

    //create the array for a list of position open right now

    for (let amm in res.data.data.amms){
        let trades = await getAllTrades(amm)
        for (const trade of trades) {
            const amm = trade.amm;
            const trader = trade.trader;
            const size = parseFloat(trade.size);
    
            await updateTrader(trader, amm, size)
        }
    }

    console.log(tradersByAmm)

    //If you are running a highly efficient system, you might miss trades between the time you get the list of trades and the time you start the listener. At this point you'll have to get clever. We recommend getting the PositionData from thegraph or thru on onchain mechanics
    
    contract.on('PositionChanged', async (amm, trader, openNotional, size, exchangedQuote, exchangedSize, realizedPnL, fundingPayment, markPrice, ifFee, ammFee, limitFee, keeperFee, event) => {
        await updateTrader(trader, amm, size)

        //loop thru now to look at liquidation
        for (const amm in tradersByAmm) {
            for (const trader in tradersByAmm[amm]) {
                if (await contract.isLiquidatable(amm, trader)){
                    try {
                        await contract.liquidate(amm, trader);
                        delete tradersByAmm[amm][trader];
                        console.log(`Successfully liquidated ${trader} in ${amm}`);
                    } catch (error) {
                        console.error(`Failed to liquidate ${trader} in ${amm}: ${error.message}`);
                    }
                }
            }
        }
    }); 
}

main()