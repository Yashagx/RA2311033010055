require('dotenv').config({ path: '../.env' });
const { Log } = require('./logger');
Log('backend', 'info', 'config', 'logger test successful').then(() => console.log('Log sent!')).catch(console.error);
