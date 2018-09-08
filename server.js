'use strict';

const async = require('async');
const http = require('http');
const Docker = require('dockerode');
const Greenlock = require('greenlock');
const LeStoreCertbot = require('le-store-certbot');
const LeChallengeStandalone = require('le-challenge-standalone');

const docker = new Docker();

const domains = {};

const leHttpChallenge = require('le-challenge-standalone').create({
	debug: false
});

var greenlockStaging = Greenlock.create({
	version: 'draft-12',
	server: 'https://acme-staging-v02.api.letsencrypt.org/directory',
	configDir: '/acme/staging/config',
	store: LeStore.create({
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
	store: LeStore.create({
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
			console.error("Failed to get production certificate for domains "+domains.join(",")+" ...", err, err && err.stack);
			callback(err);
		});
	})
}

function pollDockerServices() {
	try {
		console.log("Polling docker labels ...");
		docker.listServices({"label": "com.df.letsencrypt.host"}, function (err, services) {
			var removedDomains = Object.keys(domains).slice(0);
			services.forEach(function(service) {
				var domainsLabel = service["Spec"]["Labels"]["com.df.letsencrypt.host"];
				console.log("Adding new certificate to queue "+domainsLabel);
				if (!domains[domainsLabel]) {
					var domain = {
						domains: domainsLabel.split(/[,;]/),
						email: service["Spec"]["Labels"]["com.df.letsencrypt.email"]
					};
					domains[domainsLabel] = domain;
					getCertQueue.push(domain);
				} else if (currentDomains.indexOf(domainsLabel) !== -1){
					removedDomains.splice(currentDomains.indexOf(domainsLabel), 1);
				}
			});
			removedDomains.forEach(function(removedDomain) {
				console.log("Removing certificate from managed list "+domainsLabel);
				certificatesQueue.remove(domains[removedDomain]);
				delete domains[removedDomain];
			});
		});
	} catch(err) {
		console.error("An unexpected error occured", err);
	}
	// Poll every 30s
	setTimeout(pollDockerServices, 30000);
}

const certificatesQueue = async.queue(function(task, callback) {
	getCertificate(task.domains, task.email, function(err, cert) {
		if (err) {
			task.retryCount = (tasks.retryCount || 0) + 1;
			setTimeout(function() {
				certificatesQueue.push(task);
			}, task.retryCount * 30000);
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
http.createServer(greenlockStaging.middleware(greenlockProduction.middleware())).listen(80);
console.log("Starting docker service polling");
pollDockerServices();