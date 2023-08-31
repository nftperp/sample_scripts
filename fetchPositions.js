const axios = require("axios").default;
const { updateTrader } = require('./stateManager');

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

async function fetchPositions() {
    let res = await axios.get("https://api.nftperp.xyz/contracts");
  
    for (let amm in res.data.data.amms){
        let trades = await getAllTrades(amm)
        for (const trade of trades) {
            const amm = trade.amm;
            const trader = trade.trader;
            const size = parseFloat(trade.size);
    
            await updateTrader(trader, amm, size)
        }
    }
}

module.exports = { fetchPositions };