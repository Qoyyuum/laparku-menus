// Laparku Maps Import — opens menu.laparku.co.bn/import?url=<venue URL>
// from a toolbar click or a right-click context menu on Maps pages/links.
// Swap IMPORT_ORIGIN to a local/dev origin when testing.
const IMPORT_ORIGIN = "https://menu.laparku.co.bn";
const IMPORT_PATH = "/import";

const MAPS_URL_PATTERNS = [
  "*://*.google.com/maps/*",
  "*://maps.app.goo.gl/*",
  "*://maps.google.com/*",
  "*://*.google.*/maps/*",
];

function openImport(url) {
  if (!url) return;
  chrome.tabs.create({ url: `${IMPORT_ORIGIN}${IMPORT_PATH}?url=${encodeURIComponent(url)}` });
}

chrome.action.onClicked.addListener((tab) => openImport(tab?.url));

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "laparku-import",
    title: "Import venue into Laparku",
    contexts: ["page", "link"],
    documentUrlPatterns: MAPS_URL_PATTERNS,
    targetUrlPatterns: MAPS_URL_PATTERNS,
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  openImport(info.linkUrl ?? info.pageUrl ?? tab?.url);
});
