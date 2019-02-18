'use strict';

const async = require('async');
const http = require('http');
const path = require('path');
const Docker = require('dockerode');
const Greenlock = require('greenlock');
const LeStoreCertbot = require('le-store-certbot');
const LeChallengeStandalone = require('le-challenge-standalone');

const config = {
	DEBUG: !!process.env.DEBUG,
	STAGING_BASE_DIRECTORY: process.env.STAGING_BASE_DIRECTORY || "/acme/staging",
	LIVE_BASE_DIRECTORY: process.env.LIVE_BASE_DIRECTORY || "/acme/live",
	DISABLE_STAGING_PRECONTROL: !!process.env.DISABLE_STAGING_PRECONTROL,
	RETRY_INTERVAL: Number(process.env.RETRY_INTERVAL || 60000),
	MAX_RETRY: Number(process.env.MAX_RETRY || 10),
	DISABLE_DOCKER_SERVICE_POLLING: !!process.env.DISABLE_DOCKER_SERVICE_POLLING,
	DOCKER_POLLING_INTERVAL: Number(process.env.DOCKER_POLLING_INTERVAL || 60000),
	DOCKER_LABEL_HOST: process.env.DOCKER_LABEL_HOST || "docker.greenlock.host",
	DOCKER_LABEL_EMAIL: process.env.DOCKER_LABEL_EMAIL || "docker.greenlock.email",
	WEBHOOKS_HOST: process.env.WEBHOOKS_HOST,
	WEBHOOKS_PORT: Number(process.env.WEBHOOKS_PORT || 80),
	WEBHOOKS_PATH: process.env.WEBHOOKS_PATH || "/",
	WEBHOOKS_METHOD: process.env.WEBHOOKS_METHOD || "POST",
	RSA_KEY_SIZE: Number(process.env.RSA_KEY_SIZE || 4096),
	RENEW_DAYS_BEFORE_EXPIRE: Number(process.env.RENEW_DAYS_BEFORE_EXPIRE || 15),
	RENEW_CHECK_INTERVAL: Number(process.env.RENEW_CHECK_INTERVAL || 24 * 3600 * 1000)
};

const docker = new Docker();

const domainsCache = {};

var greenlockStaging = Greenlock.create({
	version: 'draft-12',
	server: 'https://acme-staging-v02.api.letsencrypt.org/directory',
	configDir:  path.resolve(config.STAGING_BASE_DIRECTORY, 'config'),
	store: LeStoreCertbot.create({
		configDir: path.resolve(config.STAGING_BASE_DIRECTORY, 'certs'),
		debug: config.DEBUG
	}),
	challenges: {
		'http-01': LeChallengeStandalone.create({
			debug: config.DEBUG
		})
	},
	renewWithin: (config.RENEW_DAYS_BEFORE_EXPIRE + 1) * 24 * 60 * 60 * 1000,
	renewBy: config.RENEW_DAYS_BEFORE_EXPIRE * 24 * 60 * 60 * 1000,
	debug: config.DEBUG,
	log: function () {
		let log = Array.from(arguments);
		let debug = log.shift();
		log.unshift("[Greenlock][Staging]");
		console.log.apply(console, log);
	}
});

var greenlockProduction = Greenlock.create({
	version: 'draft-12',
	server: 'https://acme-v02.api.letsencrypt.org/directory',
	configDir: path.resolve(config.LIVE_BASE_DIRECTORY, 'config'),
	store: LeStoreCertbot.create({
		configDir: path.resolve(config.LIVE_BASE_DIRECTORY, 'certs'),
		debug: config.DEBUG
	}),
	challenges: {
		'http-01': LeChallengeStandalone.create({
			debug: config.DEBUG
		})
	},
	renewWithin: (config.RENEW_DAYS_BEFORE_EXPIRE + 1) * 24 * 60 * 60 * 1000,
	renewBy: config.RENEW_DAYS_BEFORE_EXPIRE * 24 * 60 * 60 * 1000,
	debug: config.DEBUG,
	log: function () {
		let log = Array.from(arguments);
		let debug = log.shift();
		log.unshift("[Greenlock][Production]");
		console.log.apply(console, log);
	}
});

function stagingPrecontrol(domains, email, callback) {
	if (config.DISABLE_STAGING_PRECONTROL) return callback();
	if (config.DEBUG) console.log("[Staging] Trying "+domains.join(",")+" ...");
	greenlockStaging.register({
		domains: domains,
		email: email,
		agreeTos: true,
		rsaKeySize: config.RSA_KEY_SIZE
	}).then(function(certs) {
		if (config.DEBUG) console.log("[Staging] SUCCESS "+domains.join(",")+" ...");
		callback();
	}, function (err) {
		console.error("[Staging] FAILED "+domains.join(","), err);
		callback(err);
	});
}

function getCertificate(domains, email, callback) {
	if (!domains || typeof(domains.length) === "undefined") {
		return callback("Invalid domains "+domains);
	}
	if (config.DEBUG) console.log("[Cache] Checking "+domains.join(",")+" ...");
	greenlockProduction.check({ domains: domains }).then(function (results) {
		if (results) {
			console.log("[Cache] FOUND "+domains.join(",")+" (expires "+new Date(results.expiresAt)+")");
			let certificateWillExpireIn = (results.expiresAt - new Date().getTime()) / (24*60*60*1000);
			if (certificateWillExpireIn >= config.RENEW_DAYS_BEFORE_EXPIRE) {
				return callback(null, results);
			}
		}
		stagingPrecontrol(domains, email, function(err) {
			if (err) return callback(err);
			if (results) {
				if (config.DEBUG) console.log("[Renewal] Trying "+domains.join(","));
				greenlockProduction.renew({
					email: email,
					agreeTos: true,
					rsaKeySize: config.RSA_KEY_SIZE
				}, results).then(function(certs) {
					console.log("[Renewal] SUCCESS "+domains.join(","));
					callback(null, certs);
				}, function (err) {
					console.error("[Renewal] FAILED "+domains.join(","), err);
					callback(err);
				});
			} else {
				if (config.DEBUG) console.log("[Production] Trying "+domains.join(","));
				greenlockProduction.register({
					domains: domains,
					email: email,
					agreeTos: true,
					rsaKeySize: config.RSA_KEY_SIZE
				}).then(function(certs) {
					console.log("[Production] SUCCESS "+domains.join(","));
					callback(null, certs);
				}, function (err) {
					console.error("[Production] FAILED "+domains.join(","), err);
					callback(err);
				});
			}
		});
	}, function (err) {
		console.error("[Cache] ERROR "+domains.join(","), err);
		callback(err);
	});
}

function pollDockerServices() {
	try {
		if (config.DEBUG) console.log("[Docker] Polling docker labels ...");
		docker.listServices({"filters": {"label": [config.DOCKER_LABEL_HOST]}}, function (err, services) {
			if (err || !services) {
				console.error("[Docker] FAILED to get Docker service list", err);
				return;
			}
			var removedDomains = Object.keys(domainsCache).slice(0);
			services.forEach(function(service) {
				var domainsLabel = service["Spec"]["Labels"][config.DOCKER_LABEL_HOST];
				if (!domainsLabel) return;
				for (var domainLabel of domainsLabel.split(/[,;]/)) {
					if (!domainsCache[domainLabel]) {
						if (config.DEBUG) console.log("[Docker] Adding new certificate to queue "+domainLabel);
						var domain = {
							domains: [domainLabel],
							email: service["Spec"]["Labels"][config.DOCKER_LABEL_EMAIL]
						};
						domainsCache[domainLabel] = domain;
						certificatesQueue.push(domain);
					} else if (removedDomains.indexOf(domainLabel) !== -1) {
						removedDomains.splice(removedDomains.indexOf(domainLabel), 1);
					}
				}
			});
			removedDomains.forEach(function(removedDomain) {
				if (config.DEBUG) console.log("[Docker] Removing certificate from managed list "+removedDomain);
				certificatesQueue.remove(domainsCache[removedDomain]);
				delete domainsCache[removedDomain];
			});
		});
	} catch(err) {
		console.error("[Docker] An unexpected error occured", err);
	}
	// Poll every 60s
	setTimeout(pollDockerServices, config.DOCKER_POLLING_INTERVAL);
}

function checkExpiryDate() {
	async.eachOf(domainsCache, function(domain, domainLabel, callback) {
		if (config.DEBUG) console.log("[Renewal] Checking certificate for domains "+domainLabel+" ...");
		greenlockProduction.check(domain).then(function (results) {
			if (results) {
				let certificateWillExpireIn = (results.expiresAt - new Date().getTime()) / (24*60*60*1000);
				if (certificateWillExpireIn >= config.RENEW_DAYS_BEFORE_EXPIRE) {
					console.log("[Renewal] OK "+domainLabel+" (expires "+new Date(results.expiresAt)+")");
					return callback();
				}
				console.log("[Renewal] EXPIRES SOON "+domainLabel+" (expires "+new Date(results.expiresAt)+")");
				certificatesQueue.push(domain);
			}
			return callback();
		}, function (err) {
			console.error("[Renewal] ERROR "+domainLabel+" ...", err);
			callback(err);
		});
	}, function(err) {
		if (err) console.error("[Renewal] ERROR", err);
	});
	setTimeout(checkExpiryDate, config.RENEW_CHECK_INTERVAL);
}

const certificatesQueue = async.queue(async.timeout(function(task, callback) {
		getCertificate(task.domains, task.email, function(err, cert) {
			if (err) {
				task.retryCount = (task.retryCount || 0) + 1;
				if (task.retryCount > config.MAX_RETRY) {
					return console.error("[Queue] FAILED Max retries reached "+task.domains.join(","));
				}
				setTimeout(function() {
					certificatesQueue.push(task);
				}, task.retryCount * config.RETRY_INTERVAL);
			} else {
				if (config.WEBHOOKS_HOST) {
					webhooksQueue.push(cert);
				}
			}
			callback();
		});
	
}, 30000), 1);

const webhooksQueue = async.queue(function(cert, callback) {
	var req = http.request({
		  host: config.WEBHOOKS_HOST,
		  port: config.WEBHOOKS_PORT,
		  path: config.WEBHOOKS_PATH.replace(/{cert_subject}/g, cert.subject),
		  method: config.WEBHOOKS_METHOD
	}, function(res) {
		// TODO: Handle retry on failure
		console.log('[Outbound Webhook] '+cert.subject+' Status: ' + res.statusCode);
		res.setEncoding('utf8');
		res.on('data', function (chunk) {
			if (config.DEBUG) console.log('[Outbound Webhook] '+cert.subject+' Response: ' + chunk);
		});
		callback();
	});
	req.write(cert.privkey + '\n');
	req.write(cert.cert + '\n');
	req.write(cert.chain + '\n');
	req.end();
}, 1);

if (config.DEBUG) console.log("[Debug] Starting letsencrypt server on port 80");

var prefix = '/.well-known/acme-challenge/';

http.createServer(function(req, resp) {
	if (config.DEBUG) console.log("[Server] "+req.method + " " + req.url);
	if (req.url.indexOf(prefix) === 0) {
		var token = req.url.slice(prefix.length);
		var hostname = req.hostname || (req.headers.host || '').toLowerCase().replace(/:.*/, '');
		greenlockStaging.challenges['http-01'].get(Object.assign({domains: [hostname]}, greenlockStaging), hostname, token, function (err, secret) {
	        if (err) {
	        	console.error("[Http] ERROR while looking for staging secret", err);
				resp.statusCode = 404;
				resp.setHeader('Content-Type', 'application/json; charset=utf-8');
				resp.end('{ "error": { "message": "Error: These aren\'t the tokens you\'re looking for. Move along." } }');
				return;
	        }
	        if (secret) {
	        	if (config.DEBUG) console.log("[Http] FOUND staging "+hostname);
				resp.setHeader('Content-Type', 'text/plain; charset=utf-8');
				resp.end(secret);
				return;
	        }
        	greenlockProduction.challenges['http-01'].get(Object.assign({domains: [hostname]}, greenlockProduction), hostname, token, function (err, secret) {
    	        if (err || !secret) {
    	        	if (err) console.error("[Http] ERROR while looking for production secret", err);
    	        	else console.error("[Http] NOT FOUND " + hostname);
    				resp.statusCode = 404;
    				resp.setHeader('Content-Type', 'application/json; charset=utf-8');
    				resp.end('{ "error": { "message": "Error: These aren\'t the tokens you\'re looking for. Move along." } }');
    				return;
    	        }
	        	if (config.DEBUG) console.log("[Http] FOUND production "+hostname);
    			resp.setHeader('Content-Type', 'text/plain; charset=utf-8');
    			resp.end(secret);
    		});
		});
	} else {
		resp.statusCode = 404;
		resp.setHeader('Content-Type', 'application/json; charset=utf-8');
		resp.end('{ "error": { "message": "Not found" } }');
	}
}).listen(80);

if (!config.DISABLE_DOCKER_SERVICE_POLLING) {
	console.log("Starting docker service polling");
	pollDockerServices();
}

if (config.RENEW_CHECK_INTERVAL) {
	if (config.DEBUG) console.log("[Debug] Starting renewal service");
	setTimeout(checkExpiryDate, config.RENEW_CHECK_INTERVAL);
}