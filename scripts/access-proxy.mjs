// Временный защищённый шлюз: пароль обязателен для каждого запроса.
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {createHash,timingSafeEqual} from 'node:crypto';
const config=JSON.parse(readFileSync(process.env.ACCESS_CONFIG,'utf8'));
if(!config.username||!/^[a-f0-9]{64}$/.test(config.passwordHash))throw Error('Invalid access configuration');
const gatewayPort=Number(process.env.GATEWAY_PORT||3112),appHost=process.env.APP_HOST||'127.0.0.1',appPort=Number(process.env.APP_PORT||3100),appAddress=`${appHost}:${appPort}`;
const failures=new Map();
const deny=(res,status,message)=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store',...(status===401?{'WWW-Authenticate':'Basic realm="Faculty attendance", charset="UTF-8"'}:{})});res.end(message)};
const server=http.createServer((req,res)=>{
 const now=Date.now();for(const [k,v] of failures)if(v.until<now)failures.delete(k);
 const key=req.socket.remoteAddress;
 const attempt=failures.get(key)||{count:0,until:now+15*60000};
 if(attempt.count>=10)return deny(res,429,'Слишком много неверных попыток. Повторите через 15 минут.');
 const authorization=req.headers.authorization||'';
 let valid=false;
 if(authorization.startsWith('Basic ')&&authorization.length<2048){
  const decoded=Buffer.from(authorization.slice(6),'base64').toString('utf8'),split=decoded.indexOf(':');
  const actual=createHash('sha256').update(decoded.slice(split+1)).digest();
  valid=split>=0&&decoded.slice(0,split)===config.username&&timingSafeEqual(actual,Buffer.from(config.passwordHash,'hex'));
 }
 if(!valid){if(authorization){attempt.count++;failures.set(key,attempt)}return deny(res,401,'Для доступа к журналу введите выданные логин и пароль.');}
 failures.delete(key);
 if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==`https://${req.headers.host}`)return deny(res,403,'Запрос с другого сайта отклонён');
 const headers={...req.headers,host:appAddress};
 delete headers.authorization;delete headers['x-forwarded-for'];delete headers['x-forwarded-host'];delete headers['x-forwarded-proto'];
 if(req.headers.origin)headers.origin=`http://${appAddress}`;
 const upstream=http.request({hostname:appHost,port:appPort,path:req.url,method:req.method,headers},response=>{
  const result={...response.headers,'cache-control':'no-store','strict-transport-security':'max-age=86400'};
  if(result['set-cookie'])result['set-cookie']=result['set-cookie'].map(c=>/;\s*secure/i.test(c)?c:c+'; Secure');
  res.writeHead(response.statusCode,result);response.pipe(res);
 });
 upstream.on('error',()=>{if(!res.headersSent)deny(res,502,'Сервер журнала недоступен');else res.destroy()});
 req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
});
server.listen(gatewayPort,'127.0.0.1',()=>console.log(`Protected gateway on 127.0.0.1:${gatewayPort}`));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
