// CI check: runs the real player script for this OS. Music and iTunes aren't
// running on CI machines, so a working script reports "Not Running"; anything
// else means the script itself is broken.

const { getPlayerStatus } = require('../bridge/iTunesBridge');

getPlayerStatus().then((status) => {
  console.log(status);
  if (status.state === 'Unsupported') return console.log('No player script for this OS, skipping.');
  if (status.state !== 'Not Running' && !status.permission) {
    console.error('The player script failed on this OS.');
    process.exit(1);
  }
});
