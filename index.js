require('dotenv').config();
const bittrex = require('node-bittrex-api');
const bluebird = require('bluebird');
const postgres = require('pg');
const bitcoin_core = require('bitcoin-core');
const Redis = require("redis");


bluebird.promisifyAll(bittrex);

bittrex.options({
  'apikey' : process.env.API_KEY,
  'apisecret' : process.env.API_SECRET,
	verbose: false,
	inverse_callback_arguments: true
});


const pg = new postgres.Pool({connectionString: process.env.DATABASE_URL});
const wallet = new bitcoin_core({ 
    port: process.env.PORT, username: process.env.USERNAME, password: 
    process.env.PASSWORD });

const redis = Redis.createClient();
const bredis = redis.duplicate();
bluebird.promisifyAll(redis);
bluebird.promisifyAll(bredis);

// Proceso: una vez a la semana mover lo de la ultima semana de RDD a
// Bittrex, luego de recibido, venderlo por BTC, luego vender el BTC por LTC
// y enviar el LTC a bitso (o domitai, veremos, o quiza a coinomi). Si se
// envio a un exchange como domi, ponerlo a la venta por pesos, y retirar
// los pesos a GBM, para poder comprar fshop o algo asi
// Usar una especie de queue para llevar el control.

const qSENDTOEXCHANGE='sent_to_bittrex'
, qTRADES_RDDBTC='trades:rdd_btc'
, qFROMBITTREX='transfers:frombittrex';

// Pasos:
// Si hay suficiente RDD nuevo entonces enviar RDD hacia Bittrex, insertar en el queue sendtoexchange la txid
// Revisar el sendtoexchange para ver si la TX ya tiene mas de 100 confirmaciones, si ya las tiene, entonces:
//      Revisar si el proceso de conversion arrojaria unos 8 dolares, si es asi entonces:
//      Intercambia en bittrex las 
//          RDD por BTC a precio de mercado, 
//          luego el BTC a LTC, 
//          luego envia el LTC a Bitso
//          luego intercambia LTC por MXN
//          luego envia MXN a GBM
//          luego envia un email indicando que hay que comprar alguna fibra


const {RDD_BITTREX, WALLET_PASSPHRASE} = process.env;
let {MIN_AMOUNT=9000, MIN_AMOUNT_USD=8, MIN_CONFIRMATIONS=100} = process.env;
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
    //        const tx = await wallet.sendtoaddress(RDD_BITTREX, cambio);
    //        redis.lpush(qSENDTOEXCHANGE, JSON.stringify(tx));
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
        let txid;
        while((txid=await redis.rpoplpushAsync(qSENDTOEXCHANGE, qSENDTOEXCHANGE+':w'))) {
            const tx = await wallet.getTransaction(txid);
            console.log('Convirtiendo %s RDD hacia BTC', Math.abs(tx.amount));
            if(tx.confirmations>=MIN_CONFIRMATIONS) {
                const balances = await bittrex.getbalancesAsync();
                const rdd = balances.result.find(b=>b.Currency==='RDD');
                if(rdd.Available>=Math.abs(tx.amount)) {
                    console.log('Balance recibido, realizando intercambios');
                    const rdd_btc = await bittrex.gettickerAsync({market:'BTC-RDD'});
                    const trade = await bittrex.tradesellAsync({
                        MarketName: 'BTC-RDD',
                        OrderType: 'LIMIT',
                        Quantity: Math.abs(tx.amount),
                        Rate: rdd_btc.Bid,
                        TimeInEffect: 'GOOD_TIL_CANCELLED',
                        ConditionType: 'NONE',
                        Target: 0});
                    redis.lpush(qTRADES_RDDBTC, JSON.stringify(trade));
                    redis.lrem(qSENDTOEXCHANGE+':w', 0, txid);
                }
            } else {
                redis.rpoplpush(qSENDTOEXCHANGE+':w', qSENDTOEXCHANGE);
            }
        }
        
        
        // Monitorea envios de LTC a Bitso, y si ya llegaron, realiza la conversion por MXN y envio a GBM
        while((txid=await redis.rpoplpushAsync(qFROMBITTREX, qFROMBITTREX+':w'))) {

        }  
    } catch(err) {
        console.error('ERROR', err);
    } finally {
        setTimeout(()=>run(), 60000);
    }
}

run();
