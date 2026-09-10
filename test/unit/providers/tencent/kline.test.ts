import { describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import StockSDK from '../../../../src/index';
import { server } from '../../../mocks/server';

const EASTMONEY_KLINE_URL =
  'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const TENCENT_KLINE_URL =
  'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const TENCENT_MINUTE_KLINE_URL =
  'https://ifzq.gtimg.cn/appstock/app/kline/mkline';
const SINA_KLINE_URL =
  'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData';

function tencentPayload(rows: unknown[][]): Record<string, unknown> {
  return {
    code: 0,
    msg: '',
    data: {
      sh600519: {
        qfqday: rows,
      },
    },
  };
}

describe('A-share K-line provider fallback', () => {
  it('falls back to Tencent after one Eastmoney network failure', async () => {
    let eastmoneyCalls = 0;
    server.use(
      http.get(EASTMONEY_KLINE_URL, () => {
        eastmoneyCalls++;
        return HttpResponse.error();
      }),
      http.get(TENCENT_KLINE_URL, ({ request }) => {
        const param = new URL(request.url).searchParams.get('param');
        expect(param).toContain('sh600519,day,2024-05-03,2024-05-14,640,qfq');
        return HttpResponse.json(
          tencentPayload([
            ['2024-05-10', '10', '11', '12', '9', '100'],
            ['2024-05-13', '11', '12', '13', '10', '110'],
            ['2024-05-14', '12', '11', '12.5', '10.5', '120'],
          ])
        );
      })
    );

    const result = await new StockSDK().kline.cn('600519', {
      startDate: '20240513',
      endDate: '20240514',
    });

    expect(eastmoneyCalls).toBe(1);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      date: '2024-05-13',
      code: '600519',
      open: 11,
      close: 12,
      volume: 110,
      amount: null,
      change: 1,
      changePercent: 9.09,
      amplitude: 27.27,
      turnoverRate: null,
    });
    expect(result[0].tz).toBe('Asia/Shanghai');
  });

  it('treats Eastmoney data:null as soft limiting and uses Tencent', async () => {
    server.use(
      http.get(EASTMONEY_KLINE_URL, () => HttpResponse.json({ data: null })),
      http.get(TENCENT_KLINE_URL, () =>
        HttpResponse.json(
          tencentPayload([
            ['2024-05-10', '10', '11', '12', '9', '100'],
            ['2024-05-13', '11', '12', '13', '10', '110'],
          ])
        )
      )
    );

    const result = await new StockSDK().kline.cn('600519', {
      startDate: '20240513',
      endDate: '20240513',
    });
    expect(result.map((row) => row.date)).toEqual(['2024-05-13']);
  });

  it('keeps Eastmoney data when the primary source succeeds', async () => {
    const tencentHandler = vi.fn();
    server.use(
      http.get(EASTMONEY_KLINE_URL, () =>
        HttpResponse.json({
          data: {
            klines: ['2024-05-13,11,12,13,10,110,1200,25,9.09,1,2'],
          },
        })
      ),
      http.get(TENCENT_KLINE_URL, () => {
        tencentHandler();
        return HttpResponse.json(tencentPayload([]));
      })
    );

    const result = await new StockSDK().kline.cn('600519', {
      startDate: '20240513',
      endDate: '20240513',
    });
    expect(result[0].amount).toBe(1200);
    expect(tencentHandler).not.toHaveBeenCalled();
  });

  it('keeps indicator K-lines available when the A-share source falls back', async () => {
    server.use(
      http.get(EASTMONEY_KLINE_URL, () => HttpResponse.error()),
      http.get(TENCENT_KLINE_URL, () =>
        HttpResponse.json(
          tencentPayload([
            ['2024-05-10', '10', '11', '12', '9', '100'],
            ['2024-05-13', '11', '12', '13', '10', '110'],
            ['2024-05-14', '12', '13', '14', '11', '120'],
          ])
        )
      )
    );

    const result = await new StockSDK().kline.withIndicators('600519', {
      market: 'A',
      indicators: { ma: { periods: [2] } },
    });

    expect(result).toHaveLength(3);
    expect(result[1]).toMatchObject({
      date: '2024-05-13',
      close: 12,
      ma: { ma2: 11.5 },
    });
  });

  it('falls back to Tencent for 5-minute K-lines after one Eastmoney failure', async () => {
    let eastmoneyCalls = 0;
    server.use(
      http.get(EASTMONEY_KLINE_URL, () => {
        eastmoneyCalls++;
        return HttpResponse.error();
      }),
      http.get(TENCENT_MINUTE_KLINE_URL, ({ request }) => {
        const param = new URL(request.url).searchParams.get('param');
        expect(param).toBe('sh600519,m5,202405141500,640');
        return HttpResponse.json({
          code: 0,
          data: {
            sh600519: {
              m5: [
                ['202405140925', '10', '11', '12', '9', '100', {}, '0'],
                ['202405140930', '11', '12', '13', '10', '110', {}, '0'],
                ['202405140935', '12', '11', '12.5', '10.5', '120', {}, '0'],
              ],
            },
          },
        });
      })
    );

    const result = await new StockSDK().kline.cnMinute('600519', {
      period: '5',
      startDate: '2024-05-14 09:30',
      endDate: '2024-05-14 15:00',
    });

    expect(eastmoneyCalls).toBe(1);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      time: '2024-05-14 09:30',
      open: 11,
      close: 12,
      volume: 110,
      amount: null,
      change: 1,
      changePercent: 9.09,
      amplitude: 27.27,
      turnoverRate: null,
    });
  });

  it('uses Tencent minute fallback when Eastmoney returns data:null', async () => {
    server.use(
      http.get(EASTMONEY_KLINE_URL, () => HttpResponse.json({ data: null })),
      http.get(TENCENT_MINUTE_KLINE_URL, () =>
        HttpResponse.json({
          code: 0,
          data: {
            sh600519: {
              m15: [
                ['202405141000', '10', '11', '12', '9', '100', {}, '0'],
              ],
            },
          },
        })
      )
    );

    const result = await new StockSDK().kline.cnMinute('600519', {
      period: '15',
    });
    expect(result).toHaveLength(1);
    expect(result[0].time).toBe('2024-05-14 10:00');
  });

  it('falls back to Sina history when Eastmoney and Tencent are unavailable', async () => {
    server.use(
      http.get(EASTMONEY_KLINE_URL, () => HttpResponse.json({ data: null })),
      http.get(TENCENT_KLINE_URL, () =>
        HttpResponse.json({ code: 1, msg: 'temporarily unavailable' })
      ),
      http.get(SINA_KLINE_URL, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('symbol')).toBe('sh600519');
        expect(url.searchParams.get('scale')).toBe('240');
        return HttpResponse.json([
          { day: '2024-05-10', open: '10', high: '12', low: '9', close: '11', volume: '10000' },
          { day: '2024-05-13', open: '11', high: '13', low: '10', close: '12', volume: '11000' },
        ]);
      })
    );

    const result = await new StockSDK().kline.cn('600519', {
      startDate: '20240513',
      endDate: '20240513',
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      date: '2024-05-13',
      code: '600519',
      open: 11,
      close: 12,
      volume: 110,
      amount: null,
      change: 1,
      changePercent: 9.09,
      amplitude: 27.27,
      turnoverRate: null,
    });
  });

  it('falls back to Sina minute K-lines when Eastmoney and Tencent are unavailable', async () => {
    server.use(
      http.get(EASTMONEY_KLINE_URL, () => HttpResponse.json({ data: null })),
      http.get(TENCENT_MINUTE_KLINE_URL, () =>
        HttpResponse.json({ code: 1, msg: 'temporarily unavailable' })
      ),
      http.get(SINA_KLINE_URL, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('scale')).toBe('5');
        return HttpResponse.json([
          { day: '2024-05-14 09:25:00', open: '10', high: '12', low: '9', close: '11', volume: '10000' },
          { day: '2024-05-14 09:30:00', open: '11', high: '13', low: '10', close: '12', volume: '11000' },
        ]);
      })
    );

    const result = await new StockSDK().kline.cnMinute('600519', {
      period: '5',
      startDate: '2024-05-14 09:30',
      endDate: '2024-05-14 15:00',
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      time: '2024-05-14 09:30',
      volume: 110,
      amount: null,
      change: 1,
      changePercent: 9.09,
      turnoverRate: null,
    });
  });

  it('does not mask invalid minute K-line arguments with fallback data', async () => {
    const eastmoneyHandler = vi.fn();
    const tencentHandler = vi.fn();
    server.use(
      http.get(EASTMONEY_KLINE_URL, () => {
        eastmoneyHandler();
        return HttpResponse.json({ data: null });
      }),
      http.get(TENCENT_MINUTE_KLINE_URL, () => {
        tencentHandler();
        return HttpResponse.json({ code: 0, data: {} });
      })
    );

    await expect(
      new StockSDK().kline.cnMinute('600519', {
        period: '5',
        adjust: 'bad' as 'qfq',
      })
    ).rejects.toThrow(/adjust/i);

    expect(eastmoneyHandler).not.toHaveBeenCalled();
    expect(tencentHandler).not.toHaveBeenCalled();
  });
});
