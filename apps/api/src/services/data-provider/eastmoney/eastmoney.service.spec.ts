import { EastmoneyService } from './eastmoney.service';

describe('EastmoneyService', () => {
  const catalog = [
    ['015564', 'DCHY', '大成弘远回报一年持有混合A', '混合型-偏股', 'DACHENG'],
    ['090007', 'DCCL', '大成策略回报混合A', '混合型-偏股', 'DACHENG'],
    ['019455', 'ZHB', '华泰柏瑞中韩半导体ETF联接(QDII)C', '指数型-海外股票', 'HUATAI'],
    ['011840', 'THRG', '天弘中证人工智能主题ETF发起联接C', '指数型-股票', 'TIANHONG'],
    ['888881', 'TEST', '示例ETF发起式联接A', '指数型-股票', 'TEST'],
    ['888882', 'TEST', '示例ETF指数增强C', '指数型-股票', 'TEST'],
    ['888883', 'TEST', '示例沪深300ETF', '指数型-股票', 'TEST'],
    ['888884', 'TEST', '示例纳斯达克ETF(QDII)', '指数型-海外股票', 'TEST'],
    ['000198', 'HBJJ', '某货币基金', '货币型', 'HUOBI'],
    ['161999', 'LOF', '某LOF基金', '混合型', 'LOF']
  ];

  let service: EastmoneyService;
  let fetchService: { fetch: jest.Mock };

  beforeEach(() => {
    fetchService = {
      fetch: jest.fn().mockImplementation(async (url: string) => {
        if (url.includes('fundcode_search.js')) {
          return {
            ok: true,
            text: async () => 'var r = ' + JSON.stringify(catalog) + ';'
          };
        }
        if (url.includes('/f10/lsjz')) {
          return {
            ok: true,
            json: async () => ({
              ErrCode: 0,
              TotalCount: 2,
              Data: {
                LSJZList: [
                  { FSRQ: '2026-10-30', DWJZ: '1.2345' },
                  { FSRQ: '2026-10-29', DWJZ: '1.2300' }
                ]
              }
            })
          };
        }
        if (url.includes('/fhsp_')) {
          return {
            ok: true,
            text: async () => [
              '<table><tr><th>年份</th><th>权益登记日</th><th>除息日</th>',
              '<th>每份分红</th><th>分红发放日</th></tr>',
              '<tr><td>2026</td><td>2026-10-29</td><td>2026-10-30</td>',
              '<td>0.0500元</td><td>2026-11-02</td></tr></table>'
            ].join('')
          };
        }
        throw new Error('Unexpected URL ' + url);
      })
    };
    service = new EastmoneyService(
      { get: jest.fn().mockReturnValue(15000) } as any,
      fetchService as any
    );
  });

  it('searches six-digit codes without requiring MANUAL assets', async () => {
    const result = await service.search({ query: '015564' });

    expect(result.items).toEqual([
      expect.objectContaining({
        symbol: '015564',
        currency: 'CNY',
        name: '大成弘远回报一年持有混合A'
      })
    ]);
  });

  it('supports QDII ETF feeder funds but excludes money market and LOF', async () => {
    const result = await service.search({ query: '基金' });
    expect(result.items.some(({ symbol }) => symbol === '000198')).toBe(false);
    expect(result.items.some(({ symbol }) => symbol === '161999')).toBe(false);
    expect((await service.search({ query: '019455' })).items).toHaveLength(1);
  });

  it('recognizes ETF feeder variants and terminal share-class letters', async () => {
    for (const symbol of ['011840', '888881', '888882']) {
      expect((await service.search({ query: symbol })).items).toEqual([
        expect.objectContaining({ symbol, currency: 'CNY' })
      ]);
      expect(await service.getAssetProfile({ symbol })).toEqual(
        expect.objectContaining({ symbol })
      );
    }

    for (const symbol of ['888883', '888884']) {
      expect((await service.search({ query: symbol })).items).toHaveLength(0);
      expect(await service.getAssetProfile({ symbol })).toBeUndefined();
    }
  });

  it('uses the source NAV dates rather than the fetch date', async () => {
    const result = await service.getHistorical({
      from: new Date('2026-10-29T00:00:00Z'),
      to: new Date('2026-11-03T00:00:00Z'),
      symbol: '015564'
    });

    expect(result).toEqual({
      '2026-10-29': { marketPrice: 1.23 },
      '2026-10-30': { marketPrice: 1.2345 }
    });
    expect(result['2026-11-03']).toBeUndefined();
  });

  it('loads beyond the first 20 NAV records using multiple pages', async () => {
    const allRows = Array.from({ length: 45 }, (_, index) => ({
      FSRQ: new Date(Date.UTC(2026, 9, 30 - index))
        .toISOString()
        .slice(0, 10),
      DWJZ: String(1 + index / 1000)
    }));

    fetchService.fetch.mockImplementation(async (url: string) => {
      const query = new URL(url).searchParams;
      const pageSize = Number(query.get('pageSize'));
      const pageIndex = Number(query.get('pageIndex'));

      expect(pageSize).toBe(20);

      return {
        ok: true,
        json: async () => ({
          ErrCode: 0,
          TotalCount: allRows.length,
          Data: {
            LSJZList: allRows.slice(
              (pageIndex - 1) * pageSize,
              pageIndex * pageSize
            )
          }
        })
      };
    });

    const result = await service.getHistorical({
      from: new Date('2026-09-01T00:00:00Z'),
      to: new Date('2026-11-03T00:00:00Z'),
      symbol: '090007'
    });

    expect(fetchService.fetch).toHaveBeenCalledTimes(3);
    expect(Object.keys(result)).toHaveLength(45);
    expect(result['2026-10-30']).toEqual({ marketPrice: 1 });
    expect(result['2026-09-16']).toEqual({ marketPrice: 1.044 });
  });

  it('refuses to silently truncate NAV history if page counts disagree', async () => {
    fetchService.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ErrCode: 0,
        TotalCount: 45,
        Data: { LSJZList: [{ FSRQ: '2026-10-30', DWJZ: '1.1' }] }
      })
    });

    await expect(
      service.getHistorical({
        from: new Date('2026-01-01T00:00:00Z'),
        to: new Date('2026-11-03T00:00:00Z'),
        symbol: '090007'
      })
    ).rejects.toThrow('Incomplete Eastmoney NAV history');
  });

  it('rejects repeated pages if upstream ignores pageIndex', async () => {
    const samePage = Array.from({ length: 20 }, (_, index) => ({
      FSRQ: new Date(Date.UTC(2026, 9, 30 - index))
        .toISOString()
        .slice(0, 10),
      DWJZ: '1.1'
    }));

    fetchService.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ErrCode: 0,
        TotalCount: 40,
        Data: { LSJZList: samePage }
      })
    });

    await expect(
      service.getHistorical({
        from: new Date('2026-01-01T00:00:00Z'),
        to: new Date('2026-11-03T00:00:00Z'),
        symbol: '090007'
      })
    ).rejects.toThrow('pagination repeated a page');
  });

  it('returns delayed quotes so the core does not insert today's INTRADAY price', async () => {
    const result = await service.getQuotes({ symbols: ['015564'] });

    expect(result['015564']).toEqual(
      expect.objectContaining({
        marketPrice: 1.2345,
        marketState: 'delayed'
      })
    );
  });

  it('parses real Eastmoney per-10-share dividends without treating 10 as the payout', async () => {
    fetchService.fetch.mockResolvedValue({
      ok: true,
      text: async () => [
        '<html><body>',
        '<table><tr><th>年份</th><th>权益登记日</th><th>除息日</th>',
        '<th>每10份分红</th><th>分红发放日</th></tr>',
        '<tr><td>2026年</td><td>2026-01-16</td><td>2026-01-16</td>',
        '<td>每10份派现金1.4800元</td><td>2026-01-19</td></tr>',
        '<tr><td>2025年</td><td>2025-01-20</td><td>2025-01-20</td>',
        '<td>每10份派现金1.7568元</td><td>2025-01-21</td></tr>',
        '</table>',
        '<table><tr><th>拆分折算日</th><th>拆分类型</th></tr>',
        '<tr><td>2020-01-01</td><td>份额折算</td></tr></table>',
        '</body></html>'
      ].join('')
    });

    const result = await service.getDividends({
      symbol: '090007',
      from: new Date('2025-01-01T00:00:00Z'),
      to: new Date('2026-11-03T00:00:00Z')
    });

    expect(result).toEqual({
      '2025-01-20': { marketPrice: 0.17568 },
      '2026-01-16': { marketPrice: 0.148 }
    });
  });

  it('exposes per-share dividends via the existing Ghostfolio import path', async () => {
    const result = await service.getDividends({
      symbol: '015564',
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-11-03T00:00:00Z')
    });

    expect(result).toEqual({ '2026-10-30': { marketPrice: 0.05 } });
  });
});
