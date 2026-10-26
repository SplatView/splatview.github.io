import {createServer} from 'node:http';
import {writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import os from 'node:os';
const server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><canvas></canvas>');});
await new Promise(yes=>server.listen(0,'127.0.0.1',yes));
const browser=await chromium.launch({channel:'chromium',args:['--enable-unsafe-webgpu']}),page=await browser.newPage();
try{await page.goto(`http://127.0.0.1:${server.address().port}`);const value=await page.evaluate(async()=>{
  const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'}),gl=document.querySelector('canvas').getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');
  const info=adapter.info;return{userAgent:navigator.userAgent,secureContext:isSecureContext,crossOriginIsolated,
    gpu:{vendor:info.vendor,architecture:info.architecture,description:info.description,device:info.device,fallback:info.isFallbackAdapter,features:[...adapter.features]},
    gl:{vendor:gl.getParameter(ext.UNMASKED_VENDOR_WEBGL),renderer:gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)},float16Packer:typeof DataView.prototype.setFloat16};
});await writeFile('.build/app-responsiveness-20261025-01/environment.json',JSON.stringify({scope:'Post-run separate capability probe with the same Chromium launch arguments and high-performance preference. This is not per-case timing/adapter or App-host policy evidence.',
  browser:browser.version(),node:process.version,platform:process.platform,osRelease:os.release(),chromiumArguments:['--enable-unsafe-webgpu'],hostCsp:'No CSP header on this separate capability probe host. This does not qualify the App host CSP.',...value},null,2)+'\n');
console.log(JSON.stringify(value.gpu));
}finally{await browser.close();await new Promise(yes=>server.close(yes));}
