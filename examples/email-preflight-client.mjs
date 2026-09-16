// Requires Node 22+ and npm install @x402/fetch@2.26.0 @x402/core@2.26.0 @x402/evm@2.26.0 viem
// This makes ONE real paid request when configured. Keep your key in your own environment.
import { x402Client } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
const email=process.argv[2];
if(!email || !process.env.PRIVATE_KEY || !process.env.EXPECTED_SHSY_PAY_TO) throw new Error('Set PRIVATE_KEY and EXPECTED_SHSY_PAY_TO in your own environment, then pass one email as the argument. Never send your private key to SHSY.');
const account=privateKeyToAccount(process.env.PRIVATE_KEY);
const client=new x402Client().register('eip155:8453',new ExactEvmScheme(account));
client.registerPolicy((version,offers)=>offers.filter(o=>version===2 && o.scheme==='exact' && o.network==='eip155:8453' && o.asset.toLowerCase()==='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' && o.payTo.toLowerCase()===process.env.EXPECTED_SHSY_PAY_TO.toLowerCase() && BigInt(o.amount)<=1000n));
const paidFetch=wrapFetchWithPayment(fetch,client);
const response=await paidFetch('https://someonehastosayyes.com/api/agent/email-preflight',{method:'POST',headers:{'Content-Type':'application/json','X-SHSY-Source':'sdk-example'},body:JSON.stringify({email}),signal:AbortSignal.timeout(30000)});
console.log('Request ID:',response.headers.get('x-shsy-request-id'));
console.log('Payment receipt:',response.headers.get('payment-response'));
console.log('HTTP',response.status,await response.text());
// If the connection failed after payment, inspect the transaction before retrying with a new payment.
