function hasProtocol(value) {
  return /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(value)
    || /^(?:about|file|data|blob|mailto):/iu.test(value);
}

function authorityOf(value) {
  return value.split(/[/?#]/u, 1)[0] || "";
}

function hostOfAuthority(authority) {
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    return close > 0 ? authority.slice(1, close) : authority;
  }
  const lastColon = authority.lastIndexOf(":");
  if (lastColon > -1 && /^\d+$/u.test(authority.slice(lastColon + 1))) {
    return authority.slice(0, lastColon);
  }
  return authority;
}

function isLoopbackHost(host) {
  return /^(localhost|127(?:\.\d{1,3}){0,3}|0\.0\.0\.0|::1)$/iu.test(host);
}

function isIpv4Host(host) {
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/u.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

function isBracketIpv6Authority(authority) {
  return /^\[[0-9a-f:.]+\](?::\d+)?$/iu.test(authority);
}

function isLikelyDomain(host) {
  const normalized = host.replace(/\.$/u, "");
  const labels = normalized.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label))) return false;
  const tld = labels[labels.length - 1];
  return /^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/iu.test(tld);
}

function toNavigationUrl(input) {
  const value = String(input || "").trim();
  if (!value) return "about:blank";
  if (hasProtocol(value)) return value;
  if (/\s/u.test(value)) return `https://www.google.com/search?q=${encodeURIComponent(value)}`;

  const authority = authorityOf(value);
  const host = hostOfAuthority(authority);
  if (isLoopbackHost(host)) return `http://${value}`;
  if (isIpv4Host(host) || isBracketIpv6Authority(authority) || isLikelyDomain(host)) {
    return `https://${value}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

module.exports = {
  toNavigationUrl,
};
