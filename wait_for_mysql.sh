#!/usr/bin/env bash

while ! mysqladmin ping -h"$MYSQL_ADDON_HOST" -p"$MYSQL_ADDON_DB" --silent; do
    sleep 1
done