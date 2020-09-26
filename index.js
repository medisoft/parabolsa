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
	verbose: true,
	inverse_callback_arguments: true
});


const pg = new postgres.Pool({connectionString: process.env.DATABASE_URL});
const wallet = new bitcoin_core({ 
    port: process.env.PORT, username: process.env.USERNAME, password: 
    process.env.PASSWORD });

const redis = Redis.createClient();
bluebird.promisifyAll(redis);

// Proceso: una vez a la semana mover lo de la ultima semana de RDD a
// Bittrex, luego de recibido, venderlo por BTC, luego vender el BTC por LTC
// y enviar el LTC a bitso (o domitai, veremos, o quiza a coinomi). Si se
// envio a un exchange como domi, ponerlo a la venta por pesos, y retirar
// los pesos a GBM, para poder comprar fshop o algo asi
// Usar una especie de queue para llevar el control.


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
const run = async () => {
try {
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
	const data = await pg.query("select (select balance from balance where coin='RDD' and created_at=now()::date)-(select balance from balance where coin='RDD' and created_at=(now()-'1 week'::interval)::date) as cambio;");
	const cambio = Object.values(data.rows[0])[0];
	if(cambio>=9000) {
		console.log('Si hubo suficiente cambio');
		redis.lpush('tareas', 'hola');
	}
	console.log(cambio);
	console.log(await wallet.getBalance());
} catch(err) {
	console.error('ERROR', err);
}
}

/*
bittrex.getmarketsummaries( function( data, err ) {
  if (err) {
    return console.error(err);
  }
  for( var i in data.result ) {
    bittrex.getticker( { market : data.result[i].MarketName }, function(
ticker ) {
      console.log( ticker );
    });
  }
});
*/

run();
