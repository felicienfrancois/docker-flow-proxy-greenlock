FROM node:carbon
WORKDIR /usr/src/
COPY package*.json ./
RUN npm install --only=production
COPY server.js ./
EXPOSE 80
CMD [ "npm", "start" ]