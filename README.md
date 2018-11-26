# docker-greenlock

Configurable docker image to generate letsencrypt certificates with [Greenlock](https://git.coolaj86.com/coolaj86/greenlock.js)
Designed to work with [Docker-flow-proxy](https://proxy.dockerflow.com/)

*NOT YET SUITABLE FOR PRODUCTION*

Features:
- Http challenge
- Trigger certificate request though docker labels
- Always try on staging letsencrypt before trying on production
- Transmit certificate through webhooks after generation
- Automated renewal

Configuration environment variables:
- `DEBUG`
- `STAGING_BASE_DIRECTORY`
- `LIVE_BASE_DIRECTORY`
- `DISABLE_STAGING_PRECONTROL`
- `RETRY_INTERVAL`
- `MAX_RETRY`
- `DISABLE_DOCKER_SERVICE_POLLING`
- `DOCKER_POLLING_INTERVAL`
- `DOCKER_LABEL_HOST`
- `DOCKER_LABEL_EMAIL`
- `WEBHOOKS_HOST`
- `WEBHOOKS_PORT`
- `WEBHOOKS_PATH`
- `WEBHOOKS_METHOD`
- `RSA_KEY_SIZE`
- `RENEW_DAYS_BEFORE_EXPIRE`