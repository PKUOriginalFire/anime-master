import {buildApp} from './app.ts';
const {app}=await buildApp({logger:true});
await app.listen({port:Number(process.env.PORT||3010),host:process.env.HOST||'127.0.0.1'});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();});
