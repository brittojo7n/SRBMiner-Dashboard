const crypto = require("node:crypto");
const config = require("./server/utils/config");
const { Server, yieldCpuToMiner } = require("./server/server");

function main() {
	const fatal = config.validateConfig(config);
	if (fatal.length) process.exit(1);
	new Server().start();
}

if (require.main === module) {
	if (process.argv.includes("--generate-secret") || process.argv.includes("--gen-secret")) {
		console.log(crypto.randomBytes(32).toString("hex"));
		process.exit(0);
	}
	main();
}

module.exports = { Server, yieldCpuToMiner };
