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
	RENEW_DAYS_BEFORE_EXPIRE: Number(process.env.RSA_KEY_SIZE || 20),
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
		debug: false
	}),
	challenges: {
		'http-01': LeChallengeStandalone.create({
			debug: false
		})
	},
	debug: false
});

var greenlockProduction = Greenlock.create({
	version: 'draft-12',
	server: 'https://acme-v02.api.letsencrypt.org/directory',
	configDir: path.resolve(config.LIVE_BASE_DIRECTORY, 'config'),
	store: LeStoreCertbot.create({
		configDir: path.resolve(config.LIVE_BASE_DIRECTORY, 'certs'),
		debug: false
	}),
	challenges: {
		'http-01': LeChallengeStandalone.create({
			debug: false
		})
	},
	debug: false
});

function stagingPrecontrol(domains, email, callback) {
	if (config.DISABLE_STAGING_PRECONTROL) return callback();
	console.log("Trying to acquire staging certificate for domains "+domains.join(",")+" ...");
	greenlockStaging.register({
		domains: domains,
		email: email,
		agreeTos: true,
		rsaKeySize: config.RSA_KEY_SIZE
	}).then(function(certs) {
		callback();
	}, function (err) {
		console.error("Failed to get staging certificate for domains "+domains.join(",")+" ...", err, err && err.stack);
		callback(err);
	});
}

function getCertificate(domains, email, callback) {
	if (!domains || typeof(domains.length) === "undefined") {
		return callback("Invalid domains "+domains);
	}
	console.log("Checking certificate for domains "+domains.join(",")+" ...");
	greenlockProduction.check({ domains: domains }).then(function (results) {
		if (results) {
			console.log("Found certificate in storage for domains "+domains.join(",")+" (expires "+new Date(results.expiresAt)+")");
			let certificateWillExpireIn = (results.expiresAt - new Date().getTime()) / 24*60*60*1000;
			if (certificateWillExpireIn < config.RENEW_DAYS_BEFORE_EXPIRE) {
				console.log("Certificate for domains "+domains.join(",")+" will expire in "+certificateWillExpireIn+" days. Renewing ...");
			} else {
				return callback(null, results);
			}
		}
		stagingPrecontrol(domains, email, function(err) {
			if (err) return callback(err);
			console.log("Trying to acquire production certificate for domains "+domains.join(",")+" ...");
			greenlockProduction.register({
				domains: domains,
				email: email,
				agreeTos: true,
				rsaKeySize: config.RSA_KEY_SIZE
			}).then(function(certs) {
				console.log("Successfully got certificate for domains "+domains.join(",")+" ...");
				callback(null, certs);
			}, function (err) {
				console.error("Failed to get production certificate for domains "+domains.join(",")+" ...", err, err && err.stack);
				callback(err);
			});
		});
	}, function (err) {
		console.error("Failed to check certificate for domains "+domains.join(",")+" ...", err, err && err.stack);
		callback(err);
	});
}

function pollDockerServices() {
	try {
		if (config.DEBUG) console.log("Polling docker labels ...");
		docker.listServices({"filters": {"label": [config.DOCKER_LABEL_HOST]}}, function (err, services) {
			if (err || !services) {
				console.error("Failed to get Docker service list", err);
				return;
			}
			var removedDomains = Object.keys(domainsCache).slice(0);
			services.forEach(function(service) {
				var domainsLabel = service["Spec"]["Labels"][config.DOCKER_LABEL_HOST];
				if (!domainsLabel) return;
				if (!domainsCache[domainsLabel]) {
					console.log("Adding new certificate to queue "+domainsLabel);
					var domain = {
						domains: domainsLabel.split(/[,;]/),
						email: service["Spec"]["Labels"][config.DOCKER_LABEL_EMAIL]
					};
					domainsCache[domainsLabel] = domain;
					certificatesQueue.push(domain);
				} else if (removedDomains.indexOf(domainsLabel) !== -1) {
					removedDomains.splice(removedDomains.indexOf(domainsLabel), 1);
				}
			});
			removedDomains.forEach(function(removedDomain) {
				console.log("Removing certificate from managed list "+removedDomain);
				certificatesQueue.remove(domainsCache[removedDomain]);
				delete domainsCache[removedDomain];
			});
		});
	} catch(err) {
		console.error("An unexpected error occured", err);
	}
	// Poll every 60s
	setTimeout(pollDockerServices, config.DOCKER_POLLING_INTERVAL);
}

function pollCheckExpiryDate() {
	async.eachOf(domainsCache, function(domain, domainLabel, callback) {
		console.log("Checking certificate for domains "+domainLabel+" ...");
		greenlockProduction.check(domain).then(function (results) {
			if (results) {
				console.log("Found certificate in storage for domains "+domainLabel+" (expires "+new Date(results.expiresAt)+")");
				let certificateWillExpireIn = (results.expiresAt - new Date().getTime()) / 24*60*60*1000;
				if (certificateWillExpireIn >= config.RENEW_DAYS_BEFORE_EXPIRE) {
					return callback();
				}
				console.log("Certificate for domains "+domainLabel+" will expire in "+certificateWillExpireIn+" days. Renewing ...");
				certificatesQueue.push(domain);
			}
			return callback();
		}, function (err) {
			console.error("Failed to check certificate for domains "+domainLabel+" ...", err, err && err.stack);
			callback(err);
		});
	}, function(err) {
		if (err) console.error("An error occured duringexpiry date check", err);
	});
	setTimeout(pollCheckExpiryDate, config.RENEW_CHECK_INTERVAL);
}

const certificatesQueue = async.queue(async.timeout(function(task, callback) {
		getCertificate(task.domains, task.email, function(err, cert) {
			if (err) {
				task.retryCount = (task.retryCount || 0) + 1;
				if (task.retryCount > config.MAX_RETRY) {
					return console.error("Max retries reached for domains "+task.domains.join(","));
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
		console.log('Webhook Status: ' + res.statusCode);
		res.setEncoding('utf8');
		res.on('data', function (chunk) {
			console.log('Webhook response: ' + chunk);
		});
		callback();
	});
	req.write(cert.privkey + '\n');
	req.write(cert.cert + '\n');
	req.write(cert.chain + '\n');
	req.end();
}, 1);

console.log("Starting letsencrypt server on port 80");

var prefix = '/.well-known/acme-challenge/';

http.createServer(function(req, resp) {
	console.log("[Server] "+req.method + " " + req.url);
	if (req.url.indexOf(prefix) === 0) {
		var token = req.url.slice(prefix.length);
		var hostname = req.hostname || (req.headers.host || '').toLowerCase().replace(/:.*/, '');
		greenlockStaging.challenges['http-01'].get(Object.assign({domains: [hostname]}, greenlockStaging), hostname, token, function (err, secret) {
	        if (err) {
	        	console.error("Error while looking for staging secret", err);
				resp.statusCode = 404;
				resp.setHeader('Content-Type', 'application/json; charset=utf-8');
				resp.end('{ "error": { "message": "Error: These aren\'t the tokens you\'re looking for. Move along." } }');
				return;
	        }
	        if (secret) {
	        	console.log("Found staging secret for "+hostname);
				resp.setHeader('Content-Type', 'text/plain; charset=utf-8');
				resp.end(secret);
				return;
	        }
        	greenlockProduction.challenges['http-01'].get(Object.assign({domains: [hostname]}, greenlockProduction), hostname, token, function (err, secret) {
    	        if (err || !secret) {
    	        	if (err) console.error("Error while looking for production secret", err);
    	        	else console.error("Secret not found for hostname " + hostname);
    				resp.statusCode = 404;
    				resp.setHeader('Content-Type', 'application/json; charset=utf-8');
    				resp.end('{ "error": { "message": "Error: These aren\'t the tokens you\'re looking for. Move along." } }');
    				return;
    	        }
	        	console.log("Found production secret for "+hostname);
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
	setTimeout(pollCheckExpiryDate, config.RENEW_CHECK_INTERVAL);
}