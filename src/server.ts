import { createApp } from './app.js';
import { config } from './config.js';
const app = createApp();
app.listen(config.PORT, config.HOST, () => {
  console.log(`HVWA on http://${config.HOST}:${config.PORT} — DO NOT expose to untrusted networks`);
});
