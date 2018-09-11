FROM alekzonder/puppeteer:latest

WORKDIR /app

COPY index.js /app
COPY endpoint.js /app
COPY package.json /app
COPY wait_for_mysql.sh /app

USER root

RUN apt-get update -y \
 && apt-get install mysql-client -y \
 && npm install

USER pptruser

CMD ./wait_for_mysql.sh && (npm run-script server & npm run-script scraper)