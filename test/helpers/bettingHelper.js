// globals
global.assert = require('assert');
var lupi = artifacts.require("./Lupi.sol");
var BigNumber = require('bignumber.js');
var helper = new require('./helper.js');

var salt = "0xdb8780d713083a9addb6494cfc767d6ef4b1358315737e06bbb7fd84cc493d1c";
// needed to avoid polluting owner & player account with tx costs
var defaultTxAccount; // used for declareWinner, payerWinner and refund
var ownerAddress; // used for creating the contract
var accounts;

module.exports = {
    setAccounts: setAccounts,
    runBettingTest: runBettingTest
}

function setAccounts(_accounts) {
    accounts = _accounts;
    defaultTxAccount = accounts[0]; // used for declareWinner, payerWinner and refund
    ownerAddress = accounts[20]; // used for creating the contract
}

function runBettingTest(roundName, requiredBetAmount, revealPeriodLength, feePt,
        betsToPlace, expWinningIdx, expWinningNumber, toRevealCt) {
            // for no winner round pass 0 for expWinningIdx & expWinningNumbert
            // omit toRevealCt arg if you want to reveal all bets
    var ticketCountLimit = betsToPlace.length;
    if (typeof toRevealCt == "undefined") {
        toRevealCt = betsToPlace.length;
    }
    var playerAddress = (expWinningNumber == 0) ? accounts[1] : accounts[expWinningIdx];
    var expWinningAddress = (expWinningNumber == 0) ? 0 : accounts[expWinningIdx];
    var contractBalanceBefore, ownerBalanceBefore, playerBalanceBefore;
    var revealStartTime;
    var gameInstance;

    var _placeBetFn = bet => {
     // called for each betsToPlace[] via  Promise.all(). Adds ticketId to bet struct
     return new Promise(resolve => resolve(
         gameInstance.sealBet(bet.number, salt, {from: bet.playerAddress})
         .then( sealRes => {
             bet.encryptedBet = sealRes;
             return gameInstance.placeBet(sealRes, {from: bet.playerAddress, value: bet.amount})
         }).then( tx => {
             bet.ticketId = tx.logs[0].args.ticketId.toNumber() ;
             helper.logGasUse(roundName, "placeBet() ticketId: " + bet.ticketId + " | idx: " + bet.idx + " | number: " + bet.number ,  tx);
             return tx;
         })
     )); // return new Promise
    }; _placeBetFn

    var _revealBetFn = bet => {
     // called for each betsToPlace[] via  Promise.all().
     return new Promise(resolve => resolve(
         gameInstance.revealBet(bet.ticketId, bet.number, salt, {from: bet.playerAddress})
         .then( revealTx => {
             // TODO: assert revelead number is correct. here or at least once somewhere.
             helper.logGasUse(roundName, "revealBet() ticketId: " + bet.ticketId + " | idx: "
                 + bet.idx + " | number: " + bet.number, revealTx);
             return revealTx;
         })
     )); // return new Promise
    }; // _revealBetFn()

    var _refundFn = bet => {
     // called for each betsToPlace[] via  Promise.all().
     return new Promise(resolve => resolve(
         gameInstance.refund(bet.ticketId, {from: defaultTxAccount})
         .then( refundTx => {
             helper.logGasUse(roundName, "refund() ticketId: " + bet.ticketId + " | bet idx: "
                 + bet.idx + " | number: " + bet.number, refundTx);
             return refundTx;
         })
     )); // return new Promise
    }; // _refundFn()

    return lupi.new(requiredBetAmount, ticketCountLimit, revealPeriodLength, feePt, {from: ownerAddress})
    .then( res => {
        gameInstance = res;
        contractBalanceBefore = web3.eth.getBalance(gameInstance.address);
        ownerBalanceBefore = web3.eth.getBalance(ownerAddress);
        playerBalanceBefore = web3.eth.getBalance(playerAddress);
        return gameInstance.getRoundInfo();
    }).then( roundInfoRes => {
        var roundInfo = helper.parseRoundInfo(roundInfoRes);
        var expFeeAmount = requiredBetAmount * feePt / 1000000 * ticketCountLimit;
        var expWinnablePot = requiredBetAmount * ticketCountLimit - expFeeAmount;
        assert.equal(roundInfo.winnablePotAmount.toString(), expWinnablePot.toString(), "new round winnablePotAmount should be set");

        // betsToPlace transformed int a struct array  with playerAddress, encryptedBet  etc.
        for (var i = 0; i < betsToPlace.length ; i++){
            // playerAddress is ref to accounts[] (idx+1 to avoid pollutin owner ac with transaction fees)
            betsToPlace[i] = { number: betsToPlace[i], amount: requiredBetAmount, playerAddress: accounts[i+1], idx: i };
        }
        var placeBetActions = betsToPlace.map(_placeBetFn);
        var placeBetResults = Promise.all( placeBetActions );
        return placeBetResults;
    }).then( betsTxs => {
        return gameInstance.getRoundInfo();
    }).then( roundInfoRes => {
        var roundInfo = helper.parseRoundInfo(roundInfoRes);
        assert.equal(roundInfo.state, "0", "Round state should be still Betting after bet");
        assert.equal(roundInfo.ticketCount, betsToPlace.length, "ticketCount should be set");
        assert.equal(roundInfo.revealedCount, 0, "revealedCount should be 0");
        assert.equal(roundInfo.revealPeriodEnds, 0, "revealPeriodEnds should be 0 before first reveal");
        var expFeeAmount = roundInfo.requiredBetAmount.times(roundInfo.feePt/1000000).times(roundInfo.ticketCount);
        var expCurrentPot = roundInfo.requiredBetAmount.times(roundInfo.ticketCount) - expFeeAmount;
        assert.equal(roundInfo.feeAmount.toString(), expFeeAmount.toString(), "feeAmount should be set");
        assert.equal(roundInfo.currentPotAmount.toString(), expCurrentPot.toString(), "new round currentPotAmount should be set");
        assert.equal(roundInfo.winnablePotAmount.toString(), expCurrentPot.toString(), "new round winnablePotAmount should be set");
        var contractBalance = web3.eth.getBalance(gameInstance.address);
        assert.equal(contractBalance.toString(),
            contractBalanceBefore.add(roundInfo.requiredBetAmount.times(roundInfo.ticketCount)).toString(),
            "contract should receive the requiredBetAmount");

        var revealBetActions = betsToPlace.slice(0, toRevealCt).map(_revealBetFn);
        revealStartTime = Math.floor(Date.now() / 1000);
        var results = Promise.all( revealBetActions );
        return results;
    }).then( revealTxs => {
       return gameInstance.getRoundInfo();
    }).then ( roundInfoRes => {
        var roundInfo = helper.parseRoundInfo(roundInfoRes);

        if(toRevealCt == betsToPlace.length) {
            assert.equal(roundInfo.state, "1", "Round state should be Revealing after last bet revealed");
            return;
        } else {
            return gameInstance.startRevealing();
        }
    }).then( res => {
        if(toRevealCt < betsToPlace.length) { helper.logGasUse(roundName, "startRevealing()", res); }
        return gameInstance.getRoundInfo();
     }).then ( roundInfoRes => {
         var roundInfo = helper.parseRoundInfo(roundInfoRes);
        assert.equal(roundInfo.state, "1", "Round state should be Revealing after startRevealing()");
        assert.equal(roundInfo.ticketCount, betsToPlace.length, "ticketCount should be set after last bet revealed");
        assert.equal(roundInfo.revealedCount, toRevealCt, "revealedCount should be set after last bet revealed");
        assert(roundInfo.revealPeriodEnds >  revealPeriodLength + revealStartTime - 10, "revealPeriod end should be at least as expected");
        assert(roundInfo.revealPeriodEnds < revealPeriodLength + revealStartTime + 10, "revealPeriod end should be at most as expected");
        assert.equal(roundInfo.winningTicket, 0 , "The winningTicket should be yet 0 after revealBets()");
        assert.equal(roundInfo.winningNumber, 0, "The winningNumber should be yet 0 after revealBets()");
        assert.equal(roundInfo.winningAddress, 0, "The winningAddress should be yet 0 after revealBets()");

        playerBalanceBefore = web3.eth.getBalance(playerAddress);
        contractBalanceBefore = web3.eth.getBalance(gameInstance.address);
        return gameInstance.declareWinner({ from: defaultTxAccount});
    }).then( tx => {
        helper.logGasUse(roundName, "declareWinner()", tx);

        return gameInstance.getRoundInfo();
    }).then ( roundInfoRes => {
        var roundInfo = helper.parseRoundInfo(roundInfoRes);
        assert.equal(roundInfo.state, expWinningNumber == 0 ? "3" : "2", "Round state should be Won or Tied after declareWinner()");
        var expTicketId = (expWinningNumber == 0) ? 0 :  betsToPlace[expWinningIdx-1].ticketId;
        assert.equal(roundInfo.winningTicket, expTicketId, "The winningTicket should be set after declareWinner()");
        assert.equal(roundInfo.winningNumber, expWinningNumber, "The winningNumber should be set after declareWinner()");
        assert.equal(roundInfo.winningAddress, expWinningAddress, "The winningAddress should be set after declareWinner()");
        var ownerBalance = web3.fromWei(web3.eth.getBalance(ownerAddress)).toString();
        var contractBalance = web3.fromWei(web3.eth.getBalance(gameInstance.address)).toString();
        var playerBalance = web3.fromWei(web3.eth.getBalance(playerAddress)).toString();
        assert.equal(ownerBalance, web3.fromWei(ownerBalanceBefore.add(roundInfo.feeAmount)).toString(), "the fee should be sent to owner after declareWinner()");
        assert.equal(contractBalance, web3.fromWei(contractBalanceBefore.minus(roundInfo.feeAmount)).toString(), "the fee should be deducted from contractbalance after declareWinner()");
        assert.equal(playerBalance, web3.fromWei(playerBalanceBefore).toString(), "player balance should be intact (yet) after declareWinner()");

        contractBalanceBefore = web3.eth.getBalance(gameInstance.address);
        ownerBalanceBefore = web3.eth.getBalance(ownerAddress);

        if(expWinningNumber == 0 ) {
            refundActions = betsToPlace.map(_refundFn);
            var refundResults = Promise.all(refundActions );
            return refundResults.then( refundTxs => {
                return gameInstance.getRoundInfo();
            });
        } else {
            return gameInstance.payWinner({from: defaultTxAccount})
            .then( tx => {
                helper.logGasUse(roundName, "payWinner()", tx);
                return gameInstance.getRoundInfo();
            });
        }
    }).then( roundInfoRes => {
        var roundInfo = helper.parseRoundInfo(roundInfoRes);
        var ownerBalance = web3.fromWei(web3.eth.getBalance(ownerAddress)).toString();
        var contractBalance = web3.fromWei(web3.eth.getBalance(gameInstance.address)).toString();
        var playerBalance = web3.fromWei(web3.eth.getBalance(playerAddress)).toString();
        assert.equal(ownerBalance, web3.fromWei(ownerBalanceBefore).toString(), "the owner balance should be the same after payWinner()");
        assert.equal(contractBalance, web3.fromWei(contractBalanceBefore.minus(roundInfo.winnablePotAmount)).toString(), "the winnable pot should be deducted from contract balance after payWinner() or refund()");
        if(expWinningNumber == 0 ) {
            assert.equal(playerBalance, web3.fromWei(playerBalanceBefore.add(roundInfo.requiredBetAmount).minus(requiredBetAmount * feePt / 1000000)).toString(),
               "the requiredBetAmount less fee should be sent to player after refund()");
        } else {
            assert.equal(playerBalance, web3.fromWei(playerBalanceBefore.add(roundInfo.winnablePotAmount)).toString(), "the winnable pot should be sent to winner after payWinner()");
        }
        return Promise.resolve(gameInstance);
    }); // return lupi.new...
} // runBettingTest()