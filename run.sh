#!/usr/bin/env bash

function is_pid_alive {
    ps | grep -w "$1" | grep -v -q grep
}

./wait_for_mysql.sh

npm run-script server &

SERVER_PID=$!

npm run-script scraper &

while is_pid_alive ${!}; do
    sleep 5
done

echo "Scraper crashed, failing health checks"
kill -9 ${SERVER_PID}
