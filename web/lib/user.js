function parseMinerWallet(raw) {
	const first = raw == null ? "" : String(raw).split(/[,;!]/)[0].trim();
	if (!first) return "";
	const dot = first.indexOf(".");
	const slash = first.indexOf("/");
	const sep = dot !== -1 ? dot : slash;
	return (sep === -1 ? first : first.slice(0, sep)).trim();
}

function cleanPoolAddress(raw) {
	if (raw == null) return "";
	return String(raw).trim().replace(/^(?:stratum(?:\d+)?(?:\+[a-z0-9]+)?|ssl|tcp):\/\//i, "");
}

function parsePoolList(raw) {
	if (!raw) return [];
	const str = String(raw).trim();
	if (!str) return [];
	return str.split(/[,;]/).map(cleanPoolAddress).filter(Boolean);
}

function resolveIdentity(flags) {
	const rawWallet = flags ? (flags.wallet || flags.user || "") : "";
	return { wallet: parseMinerWallet(rawWallet) };
}

export { parseMinerWallet, cleanPoolAddress, parsePoolList, resolveIdentity };
