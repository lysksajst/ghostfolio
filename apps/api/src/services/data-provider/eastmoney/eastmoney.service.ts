import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import {
  DataProviderInterface,
  GetAssetProfileParams,
  GetDividendsParams,
  GetHistoricalParams,
  GetQuotesParams,
  GetSearchParams
} from '@ghostfolio/api/services/data-provider/interfaces/data-provider.interface';
import { FetchService } from '@ghostfolio/api/services/fetch/fetch.service';
import { DATE_FORMAT } from '@ghostfolio/common/helper';
import {
  DataProviderHistoricalResponse,
  DataProviderInfo,
  DataProviderResponse,
  LookupResponse
} from '@ghostfolio/common/interfaces';

import { utc } from '@date-fns/utc';
import { Injectable, Logger } from '@nestjs/common';
import {
  AssetClass,
  AssetSubClass,
  DataSource,
  SymbolProfile
} from '@prisma/client';
import { load } from 'cheerio';
import { format } from 'date-fns';

type FundRecord = [string, string, string, string, string?];
type NavRow = { FSRQ: string; DWJZ: string };

@Injectable()
export class EastmoneyService implements DataProviderInterface {
  private readonly logger = new Logger(EastmoneyService.name);
  private readonly catalogUrl = 'https://fund.eastmoney.com/js/fundcode_search.js';
  private readonly navUrl = 'https://api.fund.eastmoney.com/f10/lsjz';
  private catalogPromise?: Promise<FundRecord[]>;
  private catalogExpiresAt = 0;

  public constructor(
    private readonly configurationService: ConfigurationService,
    private readonly fetchService: FetchService
  ) {}

  public canHandle(symbol: string) {
    return /^\d{6}$/.test(symbol);
  }

  public async getAssetProfile({
    symbol
  }: GetAssetProfileParams): Promise<Partial<SymbolProfile>> {
    if (!this.canHandle(symbol)) {
      return undefined;
    }

    const record = (await this.getCatalog()).find(([code, , , category]) => {
      return code === symbol && this.isSupported(category);
    });

    return record ? this.toAssetProfile(record) : undefined;
  }

  public getDataProviderInfo(): DataProviderInfo {
    return {
      dataSource: this.getName(),
      isPremium: false,
      name: 'Eastmoney (fund NAV)',
      url: 'https://fund.eastmoney.com'
    };
  }

  public async getDividends({
    from,
    requestTimeout = this.configurationService.get('REQUEST_TIMEOUT'),
    symbol,
    to
  }: GetDividendsParams): Promise<{
    [date: string]: DataProviderHistoricalResponse;
  }> {
    if (!this.canHandle(symbol)) {
      return {};
    }

    // Only supply public dividend events. Ghostfolio remains responsible
    // for determining eligible quantities and creating DIVIDEND activities.
    try {
      const page = await this.fetchText(
        'https://fundf10.eastmoney.com/fhsp_' + symbol + '.html',
        requestTimeout
      );
      const $ = load(page);
      const result: { [date: string]: DataProviderHistoricalResponse } = {};
      const first = format(from, DATE_FORMAT, { in: utc });
      const last = format(to, DATE_FORMAT, { in: utc });

      $('table').each((_, table) => {
        const rows = $(table).find('tr');
        const headers = rows
          .first()
          .find('th, td')
          .map((_, cell) => $(cell).text().replace(/\s/g, ''))
          .get() as string[];
        const dateIndex = headers.findIndex((value) => value.includes('除息日'));
        const amountIndex = headers.findIndex((value) =>
          value.includes('每份分红')
        );

        if (dateIndex < 0 || amountIndex < 0) {
          return;
        }

        rows.slice(1).each((_, row) => {
          const cells = $(row)
            .children('td')
            .map((_, cell) => $(cell).text().replace(/\s/g, ''))
            .get() as string[];
          const date = cells[dateIndex];
          const description = cells[amountIndex] ?? '';
          const number = description.match(/(\d+(?:\.\d+)?)元?/);

          if (!this.isValidDate(date) || date < first || date > last || !number) {
            return;
          }

          const denominator = /每10份/.test(description) ? 10 : 1;
          const marketPrice = Number(number[1]) / denominator;

          if (Number.isFinite(marketPrice) && marketPrice > 0) {
            result[date] = {
              marketPrice: (result[date]?.marketPrice ?? 0) + marketPrice
            };
          }
        });
      });

      return result;
    } catch (error) {
      this.logger.warn(
        'Could not fetch dividends for ' + symbol + ': ' + String(error)
      );
      return {};
    }
  }

  public async getHistorical({
    from,
    requestTimeout = this.configurationService.get('REQUEST_TIMEOUT'),
    symbol,
    to
  }: GetHistoricalParams): Promise<{
    [date: string]: DataProviderHistoricalResponse;
  }> {
    if (!this.canHandle(symbol)) {
      return {};
    }

    const first = format(from, DATE_FORMAT, { in: utc });
    const last = format(to, DATE_FORMAT, { in: utc });
    const rows = await this.fetchNavRows({
      symbol,
      first,
      last,
      requestTimeout
    });
    const result: { [date: string]: DataProviderHistoricalResponse } = {};

    for (const { FSRQ, DWJZ } of rows) {
      const marketPrice = Number(DWJZ);

      // FSRQ is the fund's NAV date, not the day the data was fetched.
      if (
        this.isValidDate(FSRQ) &&
        FSRQ >= first &&
        FSRQ <= last &&
        Number.isFinite(marketPrice) &&
        marketPrice > 0
      ) {
        result[FSRQ] = { marketPrice };
      }
    }

    return result;
  }

  public getMaxNumberOfSymbolsPerRequest() {
    return 5;
  }

  public getName(): DataSource {
    return DataSource.EASTMONEY;
  }

  public async getQuotes({
    requestTimeout = this.configurationService.get('REQUEST_TIMEOUT'),
    symbols
  }: GetQuotesParams): Promise<{ [symbol: string]: DataProviderResponse }> {
    const result: { [symbol: string]: DataProviderResponse } = {};

    await Promise.all(
      symbols.filter((symbol) => this.canHandle(symbol)).map(async (symbol) => {
        try {
          const rows = await this.fetchNavRows({
            symbol,
            requestTimeout,
            latestOnly: true
          });
          const latest = rows[0];
          const marketPrice = Number(latest?.DWJZ);

          if (this.isValidDate(latest?.FSRQ) && marketPrice > 0) {
            result[symbol] = {
              currency: 'CNY',
              dataSource: this.getName(),
              marketPrice,
              // Never write a T-1 NAV as today's INTRADAY price.
              // Historical ingestion stores the actual FSRQ separately.
              marketState: 'delayed'
            };
          }
        } catch (error) {
          this.logger.warn(
            'Could not fetch latest NAV for ' + symbol + ': ' + String(error)
          );
        }
      })
    );

    return result;
  }

  public getTestSymbol() {
    return '015564';
  }

  public async search({
    query
  }: GetSearchParams): Promise<LookupResponse> {
    const term = query?.trim().toLowerCase();

    if (!term) {
      return { items: [] };
    }

    try {
      const records = (await this.getCatalog())
        .filter(([code, abbreviation, name, category, pinyin]) => {
          return (
            this.isSupported(category) &&
            (code.includes(term) ||
              name.toLowerCase().includes(term) ||
              abbreviation.toLowerCase().includes(term) ||
              pinyin?.toLowerCase().includes(term))
          );
        })
        .sort(([codeA, , nameA], [codeB, , nameB]) => {
          const aExact = codeA === term || nameA.toLowerCase() === term;
          const bExact = codeB === term || nameB.toLowerCase() === term;
          return Number(bExact) - Number(aExact);
        })
        .slice(0, 25);

      return {
        items: records.map((record) => {
          const profile = this.toAssetProfile(record);

          return {
            assetClass: profile.assetClass,
            assetSubClass: profile.assetSubClass,
            currency: 'CNY',
            dataProviderInfo: this.getDataProviderInfo(),
            dataSource: this.getName(),
            name: profile.name,
            symbol: profile.symbol
          };
        })
      };
    } catch (error) {
      this.logger.warn('Fund search failed: ' + String(error));
      return { items: [] };
    }
  }

  private async getCatalog(): Promise<FundRecord[]> {
    if (!this.catalogPromise || Date.now() >= this.catalogExpiresAt) {
      this.catalogPromise = this.fetchText(
        this.catalogUrl,
        this.configurationService.get('REQUEST_TIMEOUT')
      )
        .then((body) => {
          const start = body.indexOf('[');
          const end = body.lastIndexOf(']');

          if (start < 0 || end <= start) {
            throw new Error('Invalid Eastmoney fund catalog');
          }

          const parsed: unknown = JSON.parse(body.slice(start, end + 1));

          if (!Array.isArray(parsed)) {
            throw new Error('Invalid Eastmoney fund catalog');
          }

          return parsed.filter(
            (item): item is FundRecord =>
              Array.isArray(item) &&
              item.length >= 4 &&
              typeof item[0] === 'string' &&
              /^\d{6}$/.test(item[0]) &&
              typeof item[1] === 'string' &&
              typeof item[2] === 'string' &&
              typeof item[3] === 'string'
          );
        })
        .catch((error) => {
          this.catalogPromise = undefined;
          throw error;
        });
      this.catalogExpiresAt = Date.now() + 6 * 60 * 60 * 1000;
    }

    return this.catalogPromise;
  }

  private async fetchNavRows({
    symbol,
    first = '',
    last = '',
    latestOnly = false,
    requestTimeout
  }: {
    symbol: string;
    first?: string;
    last?: string;
    latestOnly?: boolean;
    requestTimeout: number;
  }): Promise<NavRow[]> {
    const pageSize = latestOnly ? 1 : 100;
    const rows: NavRow[] = [];

    for (let page = 1; page <= 100; page++) {
      const params = new URLSearchParams({
        fundCode: symbol,
        pageIndex: String(page),
        pageSize: String(pageSize),
        startDate: first,
        endDate: last
      });
      const response = await this.fetchService.fetch(
        this.navUrl + '?' + params.toString(),
        {
          headers: {
            Referer: 'https://fundf10.eastmoney.com/jjjz_' + symbol + '.html'
          },
          signal: AbortSignal.timeout(requestTimeout)
        }
      );

      if (!response.ok) {
        throw new Error('Eastmoney NAV HTTP ' + response.status);
      }

      const body = (await response.json()) as {
        Data?: { LSJZList?: NavRow[] };
        TotalCount?: number | string;
        ErrCode?: number;
      };
      const batch = body.Data?.LSJZList;

      if (body.ErrCode || !Array.isArray(batch)) {
        throw new Error('Invalid Eastmoney NAV response for ' + symbol);
      }

      rows.push(...batch);

      if (
        latestOnly ||
        batch.length < pageSize ||
        page * pageSize >= Number(body.TotalCount)
      ) {
        break;
      }
    }

    return rows;
  }

  private async fetchText(url: string, timeout: number): Promise<string> {
    const response = await this.fetchService.fetch(url, {
      signal: AbortSignal.timeout(timeout)
    });

    if (!response.ok) {
      throw new Error('Eastmoney HTTP ' + response.status);
    }

    return response.text();
  }

  private isSupported(category: string): boolean {
    // On-exchange ETFs/LOFs use Yahoo, and money-market fund NAVs
    // require a different accounting model.
    return !/货币|理财|ETF|LOF/i.test(category);
  }

  private isValidDate(date: string): boolean {
    return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
  }

  private toAssetProfile([
    symbol,
    ,
    name,
    category
  ]: FundRecord): Partial<SymbolProfile> {
    return {
      assetClass: /债券|纯债|固收/i.test(category)
        ? AssetClass.FIXED_INCOME
        : AssetClass.EQUITY,
      assetSubClass: AssetSubClass.MUTUALFUND,
      currency: 'CNY',
      dataSource: this.getName(),
      name,
      symbol
    };
  }
}
