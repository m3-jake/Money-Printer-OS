#!/usr/bin/env node
// Money Printer OS — make the Ed25519 key pair the Robinhood Crypto Trading API wants.
//
//   npm run robinhood:keygen
//
// Prints the PUBLIC key (paste it into robinhood.com/account/crypto -> API Trading when you
// create the credential; Robinhood then shows you the API key) and the PRIVATE seed (paste it
// with that API key into the app's Robinhood CONFIGURE form, or into .env as
// ROBINHOOD_PRIVATE_KEY). Nothing is written to disk here; run it again for a new pair.
import { generateRobinhoodKeyPair } from '../src/robinhoodSigner.js';

const k = generateRobinhoodKeyPair();
console.log('');
console.log('PUBLIC KEY  — paste into robinhood.com/account/crypto -> API Trading -> Add key:');
console.log('  ' + k.publicKeyBase64);
console.log('');
console.log('PRIVATE SEED (32 bytes, base64) — paste into the app CONFIGURE form as the private key. Never share it:');
console.log('  ' + k.privateKeyBase64);
console.log('');
console.log('Then: CONFIGURE (API key + this seed) -> the panel shows "key valid" -> leave "enable real" off until the paper book qualifies.');
