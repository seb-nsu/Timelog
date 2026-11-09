// Browsersprache für die Tests festlegen (jsdom meldet sonst en-US).
Object.defineProperty(window.navigator, 'language', { value: 'de-DE', configurable: true });
