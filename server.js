'use strict';

const async = require('async');
const http = require('http');
const Docker = require('dockerode');
const Greenlock = require('greenlock');
const LeStoreCertbot = require('le-store-certbot');
const LeChallengeStandalone = require('le-challenge-standalone');

const config = {
	
};

const docker = new Docker();

const domainsCache = {};

var greenlockStaging = Greenlock.create({
	version: 'draft-12',
	server: 'https://acme-staging-v02.api.letsencrypt.org/directory',
	configDir: '/acme/staging/config',
	store: LeStoreCertbot.create({
		configDir: '/acme/staging/certs',
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
	configDir: '/acme/live/config',
	store: LeStoreCertbot.create({
		configDir: '/acme/live/certs',
		debug: false
	}),
	challenges: {
		'http-01': LeChallengeStandalone.create({
			debug: false
		})
	},
	debug: false
});

function getCertificate(domains, email, callback) {
	if (!domains || typeof(domains.length) === "undefined") {
		return callback("Invalid domains "+domains);
	}
	console.log("Checking certificate for domains "+domains.join(",")+" ...");
	greenlockProduction.check({ domains: domains }).then(function (results) {
		if (results) {
			console.log("Found certificate in storage for domains "+domains.join(",")+" ...");
		    return callback(null, results);
		}
		console.log("Trying to acquire staging certificate for domains "+domains.join(",")+" ...");
		greenlockStaging.register({
			domains: domains,
			email: email,
			agreeTos: true,
			rsaKeySize: 4096
		}).then(function(certs) {
			console.log("Trying to acquire production certificate for domains "+domains.join(",")+" ...");
			greenlockProduction.register({
				domains: domains,
				email: email,
				agreeTos: true,
				rsaKeySize: 4096
			}).then(function(certs) {
				console.log("Successfully got certificate for domains "+domains.join(",")+" ...");
				callback(null, certs);
			}, function (err) {
				console.error("Failed to get production certificate for domains "+domains.join(",")+" ...", err, err && err.stack);
				callback(err);
			});
		}, function (err) {
			console.error("Failed to get staging certificate for domains "+domains.join(",")+" ...", err, err && err.stack);
			callback(err);
		});
	})
}

function pollDockerServices() {
	try {
		console.log("Polling docker labels ...");
		docker.listServices({"filters": {"label": ["com.df.letsencrypt.host"]}}, function (err, services) {
			if (err || !services) {
				console.error("Failed to get Docker service list", err);
				return;
			}
			var removedDomains = Object.keys(domainsCache).slice(0);
			services.forEach(function(service) {
				var domainsLabel = service["Spec"]["Labels"]["com.df.letsencrypt.host"];
				if (!domainsLabel) return;
				console.log("Adding new certificate to queue "+domainsLabel);
				if (!domainsCache[domainsLabel]) {
					var domain = {
						domains: domainsLabel.split(/[,;]/),
						email: service["Spec"]["Labels"]["com.df.letsencrypt.email"]
					};
					domainsCache[domainsLabel] = domain;
					certificatesQueue.push(domain);
				} else if (removedDomains.indexOf(domainsLabel) !== -1){
					removedDomains.splice(removedDomains.indexOf(domainsLabel), 1);
				}
			});
			removedDomains.forEach(function(removedDomain) {
				console.log("Removing certificate from managed list "+domainsLabel);
				certificatesQueue.remove(domainsCache[removedDomain]);
				delete domainsCache[removedDomain];
			});
		});
	} catch(err) {
		console.error("An unexpected error occured", err);
	}
	// Poll every 60s
	setTimeout(pollDockerServices, 60000);
}

const certificatesQueue = async.queue(function(task, callback) {
	getCertificate(task.domains, task.email, function(err, cert) {
		if (err) {
			task.retryCount = (task.retryCount || 0) + 1;
			setTimeout(function() {
				certificatesQueue.push(task);
			}, task.retryCount * 60000);
		} else {
			webhooksQueue.push(cert);
		}
		callback();
	});
}, 1);

const webhooksQueue = async.queue(function(cert, callback) {
	var req = http.request({
		  host: "proxy_proxy",
		  port: 8080,
		  path: "/v1/docker-flow-proxy/cert?certName="+cert.subject+".pem&distribute=true",
		  method: "PUT"
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
				res.statusCode = 404;
				res.setHeader('Content-Type', 'application/json; charset=utf-8');
				res.end('{ "error": { "message": "Error: These aren\'t the tokens you\'re looking for. Move along." } }');
				return;
	        }
	        if (secret) {
	        	console.log("Found staging secret for "+hostname);
				res.setHeader('Content-Type', 'text/plain; charset=utf-8');
				res.end(secret);
				return;
	        }
        	greenlockProduction.challenges['http-01'].get(Object.assign({domains: [hostname]}, greenlockProduction), hostname, token, function (err, secret) {
    	        if (err || !secret) {
    	        	if (err) console.error("Error while looking for production secret", err);
    	        	else console.error("Secret not found for hostname " + hostname);
    				res.statusCode = 404;
    				res.setHeader('Content-Type', 'application/json; charset=utf-8');
    				res.end('{ "error": { "message": "Error: These aren\'t the tokens you\'re looking for. Move along." } }');
    				return;
    	        }
	        	console.log("Found production secret for "+hostname);
    			res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    			res.end(secret);
    		});
		});
	} else {
		res.statusCode = 404;
		res.setHeader('Content-Type', 'application/json; charset=utf-8');
		res.end('{ "error": { "message": "Not found" } }');
	}
}).listen(80);
console.log("Starting docker service polling");
pollDockerServices();