const { ethers } = require("ethers");
const axios = require("axios").default;
const { fetchPositions } = require("./fetchPositions");
const { getTradersByAmm, updateTrader, deleteTrader } = require('./stateManager');
const ERC20_ABI = require("./abi/ERC20.json");

require("dotenv").config();

const CH_ABI = require("./abi/ClearingHouse.json");

let provider = new ethers.providers.AlchemyProvider(
    'arbitrum',
    process.env.ALCHEMY_KEY
);

let signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);


async function main(){
    let res = await axios.get("https://api.nftperp.xyz/contracts");
    let CH_ADDY = res.data.data.clearingHouse;

    let contract = new ethers.Contract(CH_ADDY, CH_ABI['abi'], signer);

    let weth_contract = new ethers.Contract(res.data.data.weth, ERC20_ABI['abi'], signer);
    const allowance = await weth_contract.allowance(signer.address, CH_ADDY);

    if (allowance.lt(ethers.utils.parseEther('1000'))) {
        await weth_contract.approve(CH_ADDY, ethers.utils.constants.MaxUint256);
    }

    await fetchPositions();
    const tradersByAmm = getTradersByAmm();


    //If you are running a highly efficient system, you might miss trades between the time you get the list of trades and the time you start the listener. At this point you'll have to get clever. We recommend getting the PositionData from thegraph or thru on onchain mechanics
    
    contract.on('PositionChanged', async (amm, trader, openNotional, size, exchangedQuote, exchangedSize, realizedPnL, fundingPayment, markPrice, ifFee, ammFee, limitFee, keeperFee, event) => {
        updateTrader(trader, amm, size)

        //loop thru now to look at liquidation
        for (const amm in tradersByAmm) {
            for (const trader in tradersByAmm[amm]) {
                if (await contract.isLiquidatable(amm, trader)){
                    try {
                        await contract.liquidate(amm, trader, String(1 * 10**18)); //the last part is the margin. 1 ether means a margin of 1X
                        deleteTrader(amm, trader);
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