const cheerio = require('cheerio')
const $logger = require('./Logger')
const $httpClient = require('./HttpClient.js')
const scraperRepository = require('../repositories/scrapperRepository.js')

const Ad = require('./Ad.js');

let page = 1
let maxPrice = 0
let minPrice = 99999999
let sumPrices = 0
let validAds = 0
let adsFound = 0
let nextPage = true

const scraper = async (url) => {
    page = 1
    maxPrice = 0
    minPrice = 99999999
    sumPrices = 0
    adsFound = 0
    validAds = 0
    nextPage = true

    const parsedUrl = new URL(url)
    const searchTerm = parsedUrl.searchParams.get('q') || ''
    const notify = await urlAlreadySearched(url)
    $logger.info(`Will notify: ${notify}`)

    do {
        currentUrl = setUrlParam(url, 'o', page)
        let response
        try {
            response        = await $httpClient(currentUrl)
            const $         = cheerio.load(response)
            nextPage        = await scrapePage($, searchTerm, notify, url)
        } catch (error) {
            $logger.error(error)
            return
        }
        page++

    } while (nextPage);

    $logger.info('Valid ads: ' + validAds)

    if (validAds) {
        const averagePrice = sumPrices / validAds;

        $logger.info('Maximum price: ' + maxPrice)
        $logger.info('Minimum price: ' + minPrice)
        $logger.info('Average price: ' + sumPrices / validAds)

        const scrapperLog = {
            url,
            adsFound: validAds,
            averagePrice,
            minPrice,
            maxPrice,
        }

        await scraperRepository.saveLog(scrapperLog)
    }
}

const scrapePage = async ($, searchTerm, notify) => {
    try {
        // Спроба 1: Шукаємо __NEXT_DATA__ (для нових версій OLX)
        let adList = extractFromNextData($)
        
        // Спроба 2: Якщо не знайшли, шукаємо альтернативні селектори
        if (!adList || !Array.isArray(adList) || !adList.length) {
            adList = extractFromAlternativeParsing($)
        }

        if (!Array.isArray(adList) || !adList.length) {
            $logger.warn('No ads found on this page')
            return false
        }

        adsFound += adList.length

        $logger.info(`Checking new ads for: ${searchTerm}`)
        $logger.info('Ads found: ' + adsFound)

        for (let i = 0; i < adList.length; i++) {

            $logger.debug('Checking ad: ' + (i + 1))

            const advert = adList[i]
            const title = advert.subject || advert.title || ''
            const id = advert.listId || advert.id || ''
            const url = advert.url || ''
            const price = parsePrice(advert.price)

            const result = {
                id,
                url,
                title,
                searchTerm,
                price,
                notify
            }

            const ad = new Ad(result)
            ad.process()

            if (ad.valid) {
                validAds++
                minPrice = checkMinPrice(ad.price, minPrice)
                maxPrice = checkMaxPrice(ad.price, maxPrice)
                sumPrices += ad.price
            }
        }

        return true
    } catch (error) {
        $logger.error('Scraping failed: ' + error);
        return false
    }
}

/**
 * Витягує оголошення з __NEXT_DATA__ скрипту (для Next.js OLX версій)
 */
const extractFromNextData = ($) => {
    try {
        const script = $('script[id="__NEXT_DATA__"]').text()

        if (!script) {
            $logger.debug('__NEXT_DATA__ not found')
            return null
        }

        const jsonData = JSON.parse(script)
        
        // Спробуємо різні можливі шляхи до даних
        let adList = 
            jsonData?.props?.pageProps?.ads ||
            jsonData?.props?.pageProps?.results ||
            jsonData?.props?.initialState?.listings ||
            null

        return adList
    } catch (error) {
        $logger.debug('Error parsing __NEXT_DATA__: ' + error.message)
        return null
    }
}

/**
 * Альтернативний парсинг за допомогою DOM селекторів
 * (якщо OLX.ua має інший формат HTML)
 */
const extractFromAlternativeParsing = ($) => {
    try {
        const adList = []
        
        // Шукаємо контейнери оголошень
        $('[data-testid="listing-item"], .listing-item, [class*="list-item"], [class*="ad-item"]').each((index, element) => {
            const $elem = $(element)
            
            // Витягуємо необхідні дані
            const id = $elem.attr('data-id') || $elem.attr('data-listing-id') || index
            const url = $elem.find('a').first().attr('href') || ''
            const title = $elem.find('[data-testid="ad-title"], h2, .title').first().text().trim() || ''
            const priceText = $elem.find('[data-testid="ad-price"], .price, [class*="price"]').first().text().trim() || '0'
            
            if (id && url && title) {
                adList.push({
                    listId: id,
                    id: id,
                    url: url,
                    subject: title,
                    title: title,
                    price: priceText
                })
            }
        })

        return adList.length > 0 ? adList : null
    } catch (error) {
        $logger.debug('Error in alternative parsing: ' + error.message)
        return null
    }
}

/**
 * Гнучкий парсинг ціни для різних форматів
 * Підтримує: R$ (Бразилія), ₴ (Україна), євро та інші
 */
const parsePrice = (priceString) => {
    try {
        if (!priceString) return 0

        // Видаляємо символи валют та пробіли
        let cleanPrice = String(priceString)
            .replace(/[R$₴€£¥]/g, '')      // Видаляємо символи валют
            .replace(/\s/g, '')             // Видаляємо пробіли
            .replace(/\./g, '')             // Видаляємо крапки (розділювачі тисяч)
            .replace(/,/g, '')              // Видаляємо коми

        const price = parseInt(cleanPrice) || 0
        return price > 0 ? price : 0
    } catch (error) {
        $logger.debug('Error parsing price: ' + error.message)
        return 0
    }
}

const urlAlreadySearched = async (url) => {
    try {
        const ad = await scraperRepository.getLogsByUrl(url, 1)
        if (ad.length) {
            return true
        }
        $logger.info('First run, no notifications')
        return false
    } catch (error) {
        $logger.error(error)
        return false
    }
}

const setUrlParam = (url, param, value) => {
    const newUrl = new URL(url)
    let searchParams = newUrl.searchParams;
    searchParams.set(param, value);
    newUrl.search = searchParams.toString();
    return newUrl.toString();
}

const checkMinPrice = (price, minPrice) => {
    if (price < minPrice && price > 0) return price
    else return minPrice
}

const checkMaxPrice = (price, maxPrice) => {
    if (price > maxPrice) return price
    else return maxPrice
}

module.exports = {
    scraper
}
