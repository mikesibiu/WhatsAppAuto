const fs = require('fs');
const path = require('path');

// Per-group persistent translation cache: <dir>/<groupId>.json keyed by message id.
function createCache(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const loaded = new Map(); // groupId -> { [msgId]: {lang, translation} }

  function fileFor(groupId) {
    return path.join(dir, `${groupId.replace(/[^a-zA-Z0-9@._-]/g, '_')}.json`);
  }

  function load(groupId) {
    if (loaded.has(groupId)) return loaded.get(groupId);
    let data = {};
    try {
      if (fs.existsSync(fileFor(groupId))) {
        data = JSON.parse(fs.readFileSync(fileFor(groupId), 'utf8'));
      }
    } catch (e) {
      console.error(`Corrupt translation cache for ${groupId}, starting fresh:`, e.message);
      data = {};
    }
    loaded.set(groupId, data);
    return data;
  }

  return {
    get(groupId, msgId) {
      return load(groupId)[msgId] || null;
    },
    setMany(groupId, entries) {
      const data = load(groupId);
      Object.assign(data, entries);
      try {
        fs.writeFileSync(fileFor(groupId), JSON.stringify(data));
      } catch (e) {
        console.error(`Failed to write translation cache for ${groupId}:`, e.message);
      }
    },
  };
}

module.exports = { createCache };
