require('dotenv').config();
const bittrex = require('node-bittrex-api');
const bluebird = require('bluebird');
const postgres = require('pg');

bluebird.promisifyAll(bittrex);

bittrex.options({
  'apikey' : process.env.API_KEY,
  'apisecret' : process.env.API_SECRET,
	verbose: true,
	inverse_callback_arguments: true
});


const pg = new postgres.Pool({connectionString: process.env.DATABASE_URL});

// Proceso: una vez a la semana mover lo de la ultima semana de RDD a
// Bittrex, luego de recibido, venderlo por BTC, luego vender el BTC por LTC
// y enviar el LTC a bitso (o domitai, veremos, o quiza a coinomi). Si se
// envio a un exchange como domi, ponerlo a la venta por pesos, y retirar
// los pesos a GBM, para poder comprar fshop o algo asi


const run = async () => {
try {
	const balances = await bittrex.getbalancesAsync();
	//console.log(balances);
	const usd = balances.result.find(b=>b.Currency==='USD');
	const ltc = balances.result.find(b=>b.Currency==='LTC');
	const btc = balances.result.find(b=>b.Currency==='BTC');
	//console.log(usd, ltc);
	const data = await pg.query('SELECT * FROM cambio_7dias');
	const cambio = Object.values(data.rows[0])[0];
	if(cambio>=9000) {
		console.log('Si hubo suficiente cambio');
	}
	console.log(cambio);
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