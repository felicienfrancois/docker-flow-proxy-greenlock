# docker-greenlock

Configurable docker image to generate letsencrypt certificates with [Greenlock](https://git.coolaj86.com/coolaj86/greenlock.js)

Designed to work with [Docker-flow-proxy](https://proxy.dockerflow.com/) as a dropin replacement for for [https://github.com/n1b0r/docker-flow-proxy-letsencrypt](https://github.com/n1b0r/docker-flow-proxy-letsencrypt)

Current status: *FUNCTIONAL BUT NOT YET TESTED ENOUGH TO BE SUITABLE FOR PRODUCTION*

### Features

- Http challenge
- Trigger certificate request though docker labels on services
- Try on staging letsencrypt servers before trying on production
- Transmit certificate through webhooks after generation
- Automated renewal

### Configuration environment variables

- `DEBUG`: enable debug logging. Default `false`
- `STAGING_BASE_DIRECTORY`: directory where staging data is stored. Default `/acme/staging`
- `LIVE_BASE_DIRECTORY`: directory where live data is stored. Default `/acme/staging`
- `DISABLE_STAGING_PRECONTROL`: disable try on staging letsencrypt environment before every try on production. Default `false`
- `RETRY_INTERVAL`: delay between each retry in ms. Default `60000` (i.e. one minute)
- `MAX_RETRY`: maximum number of retry before giving up. Default `10`
- `DISABLE_DOCKER_SERVICE_POLLING`: disable docker service polling. Default `false`
- `DOCKER_POLLING_INTERVAL`: delay between each docker services poll in ms. Default `60000` (i.e. one minute)
- `DOCKER_LABEL_HOST`: label used to specify ssl domains on docker services`. Default `docker.greenlock.host`
- `DOCKER_LABEL_EMAIL`: label used to specify admin email on docker services`. Default `docker.greenlock.email`
- `WEBHOOKS_HOST`: outbound webhook host. Default `none` (i.e. webhooks disabled)
- `WEBHOOKS_PORT`: outbound webhook port. Default `80`
- `WEBHOOKS_PATH`: outbound webhook path. Default `/`. You can use placeholder `{cert_subject}` to provide main domain in path or get parameters
- `WEBHOOKS_METHOD`: outbound webhook method. Default `POST`
- `RSA_KEY_SIZE`: RSA key size in bytes. Default `4096`
- `RENEW_DAYS_BEFORE_EXPIRE`: time when we should renew certificates in number of days before expiration. Default `15`
- `RENEW_CHECK_INTERVAL`: delay between each certificate expiration check in ms. Default `86400000` (i.e. 24 hours)

### Example configurations

#### Dropin remplacement for [n1b0r/docker-flow-proxy-letsencrypt](https://github.com/n1b0r/docker-flow-proxy-letsencrypt)

greenlock.yml

```
version: "3.4"
services:
  greenlock:
    image: felicienfrancois/docker-greenlock:latest
    networks:
      - proxy
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - sslcerts:/acme
    environment:
      DOCKER_LABEL_HOST: com.df.letsencrypt.host
      DOCKER_LABEL_EMAIL: com.df.letsencrypt.email
      WEBHOOKS_HOST: proxy_proxy
      WEBHOOKS_PORT: 8080
      WEBHOOKS_PATH: /v1/docker-flow-proxy/cert?certName={cert_subject}.pem&distribute=true
      WEBHOOKS_METHOD: PUT
    deploy:
      labels:
        - com.df.notify=true
        - com.df.servicePath=/.well-known/acme-challenge
        - com.df.port=80
        - com.df.aclName=0greenlock

volumes:
  sslcerts:
    external: true

networks:
  proxy:
    external: true
```