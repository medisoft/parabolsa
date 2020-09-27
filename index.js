require('dotenv').config();
const bittrex = require('node-bittrex-api');
const bluebird = require('bluebird');
const postgres = require('pg');
const bitcoin_core = require('bitcoin-core');
const Redis = require("redis");
const boolify = require('boolean').boolean;
const Domitai = require('@domitai/domitai-sdk');

bluebird.promisifyAll(bittrex);

bittrex.options({
  'apikey' : process.env.API_KEY,
  'apisecret' : process.env.API_SECRET,
	verbose: false,
	inverse_callback_arguments: true
});

const domitai = Domitai({
  apiKey: process.env.DOMITAI_API_KEY,
  apiSecret: process.env.DOMITAI_API_SECRET,
  apiURL: process.env.DOMITAI_URL,
  preferSocket: boolify(process.env.USE_SOCKET),
  markets: [ ]
});


const pg = new postgres.Pool({connectionString: process.env.DATABASE_URL});
const wallet = new bitcoin_core({ 
    port: process.env.PORT, 
    username: process.env.USERNAME, 
    password: process.env.PASSWORD });

const ltc_wallet = new bitcoin_core({
    port: process.env.LTC_PORT, 
    username: process.env.LTC_USERNAME, 
    password: process.env.LTC_PASSWORD 
    });

const redis = Redis.createClient();
const bredis = redis.duplicate();
bluebird.promisifyAll(redis);
bluebird.promisifyAll(bredis);

// Proceso: una vez a la semana mover lo de la ultima semana de RDD a
// Bittrex, luego de recibido, venderlo por BTC, luego vender el BTC por LTC
// y enviar el LTC a domitai (o bitso, veremos, o quiza a coinomi). Si se
// envio a un exchange como domi, ponerlo a la venta por pesos, y retirar
// los pesos a GBM, para poder comprar fshop o algo asi
// Usar una especie de queue para llevar el control.

const qSENDTOEXCHANGE='sent_to_bittrex'
, qTRADES_RDDBTC='trades:rdd_btc'
, qTRADES_BTCLTC='trades:btc_ltc'
, qTRADES_LTCMXN='trades:ltc_mxn'
, qFROMBITTREX='transfers:frombittrex'
, qRETIROS='retiros:domitai';

// Pasos:
// Si hay suficiente RDD nuevo entonces enviar RDD hacia Bittrex, insertar en el queue sendtoexchange la txid
// Revisar el sendtoexchange para ver si la TX ya tiene mas de 100 confirmaciones, si ya las tiene, entonces:
//      Revisar si el proceso de conversion arrojaria unos 8 dolares, si es asi entonces:
//      Intercambia en bittrex las 
//          RDD por BTC a precio de mercado, 
//          luego el BTC a LTC, 
//          luego envia el LTC a Domitai
//          luego intercambia LTC por MXN
//          luego envia MXN a GBM
//          luego envia un email indicando que hay que comprar alguna fibra


const {RDD_BITTREX, WALLET_PASSPHRASE} = process.env;
let {MIN_AMOUNT=9000, MIN_AMOUNT_USD=8, MIN_CONFIRMATIONS=50} = process.env;
MIN_AMOUNT=Number(MIN_AMOUNT);
MIN_AMOUNT_USD=Number(MIN_AMOUNT_USD);
MIN_CONFIRMATIONS=Number(MIN_CONFIRMATIONS);
const run = async () => {
    try {
        const cambio = Number((await pg.query("select (select balance from balance where coin='RDD' and created_at=now()::date)-(select balance from balance where coin='RDD' and created_at=(now()-'1 week'::interval)::date) as cambio;")).rows[0].cambio);
        const ultimo_balance_registrado = Number((await pg.query("SELECT balance FROM balance WHERE coin='RDD' AND created_at=now()::date")).rows[0].balance);
        const ultimo_balance_wallet = Number(await wallet.getBalance());
        if(!process.env.MIN_AMOUNT) throw new Error('No existe el MIN_AMOUNT');
        const rdd_btc = await bittrex.gettickerAsync({market:'BTC-RDD'});
        const usd_btc = await bittrex.gettickerAsync({market:'USD-BTC'});
        const monto_en_usd = (rdd_btc.result.Bid*cambio) * usd_btc.result.Ask;
        // Si hay monto suficiente, realiza el envio de RDDs
        if(cambio>=MIN_AMOUNT && ultimo_balance_wallet>=ultimo_balance_registrado && monto_en_usd>=MIN_AMOUNT_USD) {
            const balances = await bittrex.getbalancesAsync();
            const rdd = balances.result.find(b=>b.Currency==='RDD')
            console.log('Enviando %s RDD (%s USD) a Bittrex %s', cambio, monto_en_usd, RDD_BITTREX);
            await wallet.walletPassphrase(WALLET_PASSPHRASE, 60, false);
            const tx = await wallet.sendToAddress(RDD_BITTREX, cambio);
            redis.lpush(qSENDTOEXCHANGE, tx);
            await wallet.walletPassphrase(WALLET_PASSPHRASE, 999999999, true);
        }

    /*
            const balances = await bittrex.getbalancesAsync();
            //console.log(balances);
            const usd = balances.result.find(b=>b.Currency==='USD');
            const ltc = balances.result.find(b=>b.Currency==='LTC');
            const btc = balances.result.find(b=>b.Currency==='BTC');
            const rdd_btc = await bittrex.gettickerAsync({market:'BTC-RDD'});
            const usd_btc = await bittrex.gettickerAsync({market:'USD-BTC'});
            const btc_ltc = await bittrex.gettickerAsync({market:'BTC-LTC'});
            //console.log(usd, ltc);
            //console.log(btc_ltc);
            * */
        
        // Monitorea envios de RDDs, y si ya llegaron, realiza las operaciones de conversion en Bittrex
        while((await redis.rpoplpushAsync(qSENDTOEXCHANGE+':w', qSENDTOEXCHANGE)));
        let txid;
        while((txid=await redis.rpoplpushAsync(qSENDTOEXCHANGE, qSENDTOEXCHANGE+':w'))) {
            const tx = await wallet.getTransaction(txid);
            if(tx.confirmations>=MIN_CONFIRMATIONS) {
                console.log('Convirtiendo %s RDD hacia BTC', Math.abs(tx.amount));
                const balances = await bittrex.getbalancesAsync();
                const rdd = balances.result.find(b=>b.Currency==='RDD');
                if(rdd.Available>=Math.abs(tx.amount)) {
                    console.log('Balance recibido, realizando intercambios');
                    const rdd_btc = await bittrex.gettickerAsync({market:'BTC-RDD'});
                    const trade = await bittrex.selllimitAsync({
                        market: 'BTC-RDD',
                        quantity: Math.abs(tx.amount),
                        rate: rdd_btc.result.Bid,
                        timeInForce: 'GTC'
                    });

                    await redis.lpushAsync(qTRADES_RDDBTC, JSON.stringify(trade));
                    await redis.lremAsync(qSENDTOEXCHANGE+':w', 0, txid);
                }
            } else {
                console.log('Esperando confirmaciones (%s/%s) para enviar %s RDD hacia BTC', tx.confirmations, MIN_CONFIRMATIONS, Math.abs(tx.amount));
            }
        }


        // Convierte BTC -> LTC
        while((await redis.rpoplpushAsync(qTRADES_RDDBTC+':w', qTRADES_RDDBTC)));
        while((tx=await redis.rpoplpushAsync(qTRADES_RDDBTC, qTRADES_RDDBTC+':w'))) {
            const o = await bittrex.getorderAsync({uuid:JSON.parse(tx).result.uuid});
            if(o.result.QuantityRemaining===0) { // Convertir BTC->LTC
                const {CommissionPaid, Price} = o.result, quantity = (Price-CommissionPaid);
                const btc_ltc = await bittrex.gettickerAsync({market:'BTC-LTC'});
                console.log({
                    market: 'BTC-LTC',
                    quantity: (quantity/btc_ltc.result.Ask*0.998).toFixed(8),
                    rate: btc_ltc.result.Ask,
                    timeInForce: 'GTC'
                });
                const trade = await bittrex.buylimitAsync({
                    market: 'BTC-LTC',
                    quantity: (quantity/btc_ltc.result.Ask*0.998).toFixed(8),
                    rate: btc_ltc.result.Ask,
                    timeInForce: 'GTC'
                });

                await redis.lpushAsync(qTRADES_BTCLTC, JSON.stringify(trade));
                await redis.lremAsync(qTRADES_RDDBTC+':w', 0, tx);
            }
        }        
        

        // Envia los LTC a Domitai
        while((await redis.rpoplpushAsync(qTRADES_BTCLTC+':w', qTRADES_BTCLTC)));
        while((tx=await redis.rpoplpushAsync(qTRADES_BTCLTC, qTRADES_BTCLTC+':w'))) {
            const o = await bittrex.getorderAsync({uuid:JSON.parse(tx).result.uuid});
            if(o.result.QuantityRemaining===0) { // Envia LTC a Domitai
                const { Quantity, CommissionPaid, Price} = o.result, quantity = (Quantity-CommissionPaid);
                console.log('Listo para enviar %s LTC a Domitai', quantity);
                const trade = await bittrex.withdrawAsync({
                    currency: 'LTC',
                    quantity,
                    address: process.env.DIRECCION_EXCHANGE
                });
                console.log('Retiro', trade);
                await redis.lpushAsync(qFROMBITTREX, JSON.stringify(trade));
                await redis.lremAsync(qTRADES_BTCLTC+':w', 0, tx);
            }
        }        

        //console.log(await domitai.balance('LTC'));
        
    
        // Monitorea envios de LTC a Domitai, y si ya llegaron, realiza la conversion por MXN
        while((await redis.rpoplpushAsync(qFROMBITTREX+':w', qFROMBITTREX)));
        while((tx=await redis.rpoplpushAsync(qFROMBITTREX, qFROMBITTREX+':w'))) {
            let o = await bittrex.getwithdrawalhistoryAsync({currency:'LTC'});
            o=o.result.find(t=>t.PaymentUuid===JSON.parse(tx).result.uuid);
            if(!o.PendingPayment) {
                if((await ltc_wallet.getRawTransaction(o.TxId, true)).confirmations>6) {
                    const ltc_mxn = await domitai.ticker('ltc_mxn');
                    const {Amount}=o, {bid, ask}=ltc_mxn.payload, rate = ((Number(ask)+Number(bid))/2).toFixed(2);
                    const trade = await domitai.sell('ltc_mxn', Amount, rate, {magic:99});
                    await redis.lpushAsync(qTRADES_LTCMXN, JSON.stringify(trade));
                    await redis.lremAsync(qFROMBITTREX+':w', 0, tx);
                }
            }
        }  


        // Monitorea la operacion de venta de LTC, y una vez hecha, realiza el retiro a GBM
        while((await redis.rpoplpushAsync(qTRADES_LTCMXN+':w', qTRADES_LTCMXN)));
        while((tx=await redis.rpoplpushAsync(qTRADES_LTCMXN, qTRADES_LTCMXN+':w'))) {
            let o = await domitai.orders();
            o=o.payload.find(t=>t.id===JSON.parse(tx).payload.id);
            if(!o) {
                const {total, id} = JSON.parse(tx).payload, amount=(total*0.995).toFixed(2), description=`Conversion de RDD ${id}`;
                const extra = {address:process.env.GBM_TRADING};
                console.log('Orden finalizada', amount, description, extra);
//                redis.lpush(qRETIROS, JSON.stringify(await domitai.withdraw({fee:2, amount, extra, description})));;
//                await redis.lremAsync(qTRADES_LTCMXN+':w', 0, tx);
            }
        }  

    } catch(err) {
        console.error('ERROR', err);
    } finally {
        setTimeout(()=>run(), 3600000);
    }
}

run();
