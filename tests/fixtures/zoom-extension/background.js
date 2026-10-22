// Test fixture only, never shipped. Uses the browser's actual per-tab zoom:
// https://developer.chrome.com/docs/extensions/reference/api/tabs#method-setZoom
globalThis.splatviewZoom = {
  async set(url, factor) {
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol) || target.hostname !== '127.0.0.1' || ![1, 2, 4].includes(factor))
      throw new Error('Only explicit loopback test pages and 100/200/400 percent zoom are allowed.');
    const tabs = await chrome.tabs.query({ url: ['http://127.0.0.1/*', 'https://127.0.0.1/*'] });
    const matches = tabs.filter(tab => tab.url === url && Number.isInteger(tab.id));
    if (matches.length !== 1) throw new Error(`Expected one current test tab, found ${matches.length}.`);
    const tabId = matches[0].id;
    await chrome.tabs.setZoomSettings(tabId, { mode: 'automatic', scope: 'per-tab' });
    await chrome.tabs.setZoom(tabId, factor);
    return { tabId, factor: await chrome.tabs.getZoom(tabId), url: matches[0].url };
  }
};
