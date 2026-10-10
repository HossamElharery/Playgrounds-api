const {NestFactory} = require('@nestjs/core');
const {AppModule} = require('../dist/src/modules/app/app.module');
const {configureApp} = require('../dist/src/bootstrap');
async function main() {
  const port = Number(process.env.PORT ?? 3102);
  if (!Number.isInteger(port) || port < 3102 || port > 3199) throw new Error('Reserved social QA API port required');
  const app=await NestFactory.create(AppModule,{logger:['warn','error']});
  configureApp(app);
  await app.listen(port,'127.0.0.1');
  console.log(`Social QA API ready on http://127.0.0.1:${port} (loopback only).`);
}
main().catch(()=>{console.error('Social QA API failed to initialize.');process.exit(1);});
