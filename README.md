# MicrosoftStoreCrawler

## Requirements

- download and install nodejs ([https://nodejs.org/en/download](https://nodejs.org/en/download)) 
- install puppeteer (`npm i puppeteer`)

## Gathering list of apllications from microsoft store

Run `.\runAppCrawler.ps1` in PowerShell to use the default URL, or provide a specific URL as an argument: `.\runAppCrawler.ps1 <url>`. 

This script crawls the microsoft page and collects relevant metadata, including the application name, ID, URL, and category. Only applications with a *free* pricing model are included in the results. If the crawler does not return any data, inspect [crawl](scripts/crawlAppData.js) and update the isFreePrice function by adding the relevant keywords that indicate a free pricing model.