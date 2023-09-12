const { ethers } = require("ethers");
const axios = require("axios").default;
const { fetchPositions } = require("./fetchPositions"); // Import the new library
const { getTradersByAmm, updateTrader, deleteTrader } = require('./stateManager');
require("dotenv").config();

const CH_ABI = require("./abi/ClearingHouse.json");

let provider = new ethers.AlchemyProvider(
    'arbitrum',
    process.env.ALCHEMY_KEY
);

let signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);


async function main(){
    let res = await axios.get("https://api.nftperp.xyz/contracts");

    let reversedAmms = {};

    for (const [key, value] of Object.entries(res.data.data.amms)) {
        reversedAmms[value] = key;
    }

    let CH_ADDY = res.data.data.clearingHouse;

    let contract = new ethers.Contract(CH_ADDY, CH_ABI['abi'], signer);

    await fetchPositions();
    const tradersByAmm = getTradersByAmm();

    contract.on('PositionChanged', async (amm, trader, openNotional, size, exchangedQuote, exchangedSize, realizedPnL, fundingPayment, markPrice, ifFee, ammFee, limitFee, keeperFee, event) => {
        
        try{
            for (const amm in tradersByAmm) {
                for (const trader in tradersByAmm[amm]) {
                    let triggerOrders = await axios.get(`https://api.nftperp.xyz/orders/trigger?amm=${reversedAmms[amm]}&trader=${trader}`)
        
                    for (const triggerOrder of triggerOrders.data.data) {
                        console.log(triggerOrder)
                        console.log(amm, triggerOrder.trader)
                        let pos = await contract.getPosition(amm, triggerOrder.trader)
        
                        let direction;
        
                        if (pos.size > 0){
                            direction = 'long'
                        } else {
                            direction = 'short'
                        }
        
                        if (triggerOrder.takeProfit == false){
                            if (direction == 'long'){
                                if (markPrice  <= triggerOrder.trigger) {
                                    console.log(`Trigger Order with ID ${triggerOrder.id} has been triggered at mark price ${markPrice}`);
                                    await contract.closePositionKeeper(amm, triggerOrder.id)
                                    
                                }
                            }
                            else{
                                if (markPrice  >= triggerOrder.trigger ) {
                                    console.log(`Trigger Order with ID ${triggerOrder.id} has been triggered at mark price ${markPrice}`);
                                    await contract.closePositionKeeper(amm, triggerOrder.id)
                                }
                            }
                        } else {
                            if (direction == 'long'){
                                if (markPrice  >= triggerOrder.trigger) {
                                    console.log(`Trigger Order with ID ${triggerOrder.id} has been triggered at mark price ${markPrice}`);
                                    await contract.closePositionKeeper(amm, triggerOrder.id)
                                }
                            }
                            else{
                                if (markPrice  <= triggerOrder.trigger ) {
                                    console.log(`Trigger Order with ID ${triggerOrder.id} has been triggered at mark price ${markPrice}`);
                                    await contract.closePositionKeeper(amm, triggerOrder.id)
        
                                }
                            }
                        }
                    }
                }
            }
        }
        catch (error) {
            console.error(error)
        }
    });
}

main()