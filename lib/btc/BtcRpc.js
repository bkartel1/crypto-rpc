const BitcoinRPC = require('./bitcoin');
const promptly = require('promptly');
const util = require('util');
const EventEmitter = require('events');

const passwordPromptAsync = util.promisify(promptly.password);

class BtcRpc {
  constructor(config) {
    this.config = config;
    const {
      rpcPort: port,
      rpcUser: user,
      rpcPass: pass,
      host,
      protocol
    } = config;
    this.rpc = new BitcoinRPC({ host, port, user, pass, protocol });
    this.emitter = new EventEmitter();
  }

  asyncCall(method, args) {
    return new Promise((resolve, reject) => {
      this.rpc[method](...args, (err, response) => {
        if (err instanceof Error) {
          return reject(err);
        }

        const { error, result } = response;
        if (error) {
          err = new Error(error.message);
          err.code = error.code; // used by methods below
          err.conclusive = true; // used by server
          return reject(err);
        }
        if (result && result.errors) {
          return reject(new Error(result.errors[0]));
        }
        return resolve(result);
      });
    });
  }

  async cmdlineUnlock({ time }) {
    return this.asyncCall('cmdlineUnlock', [time]);
  }

  async sendMany({ batch, options }) {
    let batchClone = Object.assign({}, batch);
    for (let tx in batch) {
      batchClone[tx] /= 1e8;
    }
    const paramArray = ['', batchClone];
    if (options) {
      paramArray.push(options);
    }
    return this.asyncCall('sendMany', paramArray);
  }

  async sendToAddress({ address, amount }) {
    return this.asyncCall('sendToAddress', [address, amount / 1e8]);
  }

  async unlockAndSendToAddress({ address, amount, passphrase }) {
    if (passphrase === undefined) {
      passphrase = await passwordPromptAsync('> ');
    }
    await this.walletUnlock({ passphrase, time: 10800 });
    const tx = await this.sendToAddress({ address, amount });
    await this.walletLock();
    return tx;
  }

  async unlockAndSendToAddressMany({ payToArray, passphrase, time = 10800, maxValue = 10*1e8, maxOutputs = 1 }) {
    let payToArrayClone = [...payToArray];
    if (passphrase === undefined) {
      passphrase = await passwordPromptAsync('> ');
    }
    if (payToArrayClone.length < maxOutputs) {
      maxOutputs = payToArrayClone.length;
    }
    await this.walletUnlock({ passphrase, time });
    let payToArrayResult = [];
    while (payToArrayClone.length) {
      let currentValue = 0;
      let currentOutputs = 0;
      let batch = {};
      let tempArray = [];
      while (currentValue < maxValue && currentOutputs < maxOutputs) {
        if (payToArrayClone.length < maxOutputs) {
          maxOutputs = payToArrayClone.length;
        }
        let tx = payToArrayClone.shift();
        tempArray.push(tx);
        let address = tx.address;
        let amount = tx.amount;
        if (!batch[address]) {
          batch[address] = 0;
        }
        batch[address] += amount;
        currentValue += amount;
        currentOutputs++;
      }
      let emitData = {
        data: {},
        txid: '',
        error: null
      };
      try {
        let txid = await this.sendMany({ batch });
        emitData.data = batch;
        emitData.txid = txid;
        let voutCounter = 1;
        for (let tx of tempArray) {
          tx.txid = txid;
          tx.vout = voutCounter;
          payToArrayResult.push(tx);
          voutCounter++;
        }
        this.emitter.emit('success', emitData);
      } catch (error) {
        emitData.error = error;
        emitData.data = batch;
        this.emitter.emit('failure', emitData);
        for (let tx of tempArray) {
          tx.error = error;
          payToArrayResult.push(tx);
        }
      }
    }
    await this.walletLock();
    this.emitter.emit('done');
    return payToArrayResult;
  }

  async walletUnlock({ passphrase, time }) {
    this.emitter.emit('unlocked', time );
    return this.asyncCall('walletPassPhrase', [passphrase, time]);
  }

  async walletLock() {
    this.emitter.emit('locked');
    return this.asyncCall('walletLock', []);
  }

  async estimateFee({ nBlocks }) {
    const { feerate: feeRate } = await this.asyncCall('estimateSmartFee', [
      nBlocks,
    ]);
    const satoshisPerKb = Math.round(feeRate * 1e8);
    const satoshisPerByte = satoshisPerKb / 1e3;
    return satoshisPerByte;
  }

  async getBalance() {
    const balanceInfo = await this.asyncCall('getWalletInfo', []);
    return balanceInfo.balance * 1e8;
  }

  async getBestBlockHash() {
    return this.asyncCall('getBestBlockHash', []);
  }

  async getTransaction({ txid, detail = false }) {
    const tx = await this.getRawTransaction({ txid });

    if (tx && detail) {
      for (let input of tx.vin) {
        const prevTx = await this.getTransaction({ txid: input.txid });
        const utxo = prevTx.vout[input.vout];
        const { value } = utxo;
        const address =
          utxo.scriptPubKey.addresses &&
          utxo.scriptPubKey.addresses.length &&
          utxo.scriptPubKey.addresses[0];
        input = Object.assign(input, {
          value,
          address,
          confirmations: prevTx.confirmations
        });
      }
      tx.unconfirmedInputs = tx.vin.some(input => input.confirmations < 1);
      let totalInputValue = tx.vin.reduce(
        (total, input) => total + input.value * 1e8,
        0
      );
      let totalOutputValue = tx.vout.reduce(
        (total, output) => total + output.value * 1e8,
        0
      );
      tx.fee = totalInputValue - totalOutputValue;
    }

    return tx;
  }

  async getRawTransaction({ txid }) {
    try {
      return await this.asyncCall('getRawTransaction', [txid, 1]);
    } catch (err) {
      if (err.code === -5) {
        return null;
      }
      throw err;
    }
  }

  async sendRawTransaction({ rawTx }) {
    return this.asyncCall('sendRawTransaction', [rawTx]);
  }

  async decodeRawTransaction({ rawTx }) {
    return this.asyncCall('decodeRawTransaction', [rawTx]);
  }

  async getBlock({ hash }) {
    return this.asyncCall('getBlock', [hash]);
  }

  async getConfirmations({ txid }) {
    const tx = await this.getTransaction({ txid });
    if (!tx) {
      return null;
    }
    if (tx.blockhash === undefined) {
      return 0;
    }
    return tx.confirmations;
  }

  async getTip() {
    const blockchainInfo = await this.asyncCall('getblockchaininfo', []);
    const { blocks: height, bestblockhash: hash } = blockchainInfo;
    return { height, hash };
  }

  async validateAddress({ address }) {
    const validateInfo = await this.asyncCall('validateaddress', [address]);
    const { isvalid } = validateInfo;
    return isvalid;
  }
}

module.exports = BtcRpc;
