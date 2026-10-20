import {buildApp} from '../server/app.ts';
const adminPassword=process.env.PREVIEW_ADMIN_PASSWORD;
if(!adminPassword){console.error('请设置 PREVIEW_ADMIN_PASSWORD（至少 10 个字符）后启动本地预览。');process.exit(1);}
const {app}=await buildApp({dir:'.local/preview-data',adminUsername:'preview',adminPassword,origin:'http://127.0.0.1:3010',logger:false});
await app.listen({port:3010,host:'127.0.0.1'});
console.log('本地预览：http://127.0.0.1:3010');
for(const s of ['SIGINT','SIGTERM'])process.once(s,async()=>app.close());
