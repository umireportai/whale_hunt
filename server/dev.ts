export {};

process.env.NODE_ENV = 'production';
process.env.HOST = '127.0.0.1';
process.env.API_PORT = '8311';
await import('./index.js');
