let tradersByAmm = {};


function getTradersByAmm() {
    return tradersByAmm;
}

function deleteTrader(amm, trader) {
    if (tradersByAmm[amm] && tradersByAmm[amm][trader]) {
        delete tradersByAmm[amm][trader];
    }
}

function updateTrader(trader, amm, size) {
    if (!tradersByAmm[amm]) {
        tradersByAmm[amm] = {};
    }

    if (!tradersByAmm[amm][trader]) {
        tradersByAmm[amm][trader] = 0;
    }

    tradersByAmm[amm][trader] += size;

    if (Math.abs(tradersByAmm[amm][trader]) < Math.abs(0.001)) {
        delete tradersByAmm[amm][trader];
    }
}

module.exports = {
    getTradersByAmm,
    updateTrader,
    deleteTrader
};