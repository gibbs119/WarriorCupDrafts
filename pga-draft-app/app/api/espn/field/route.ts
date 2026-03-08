import { NextRequest, NextResponse } from 'next/server';
import { ESPN_FIELD_URL } from '@/lib/espn';

export async function GET(req: NextRequest) {
  const eventId = req.nextUrl.searchParams.get('eventId');

  if (!eventId) {
    return NextResponse.json({ error: 'Missing eventId' }, { status: 400 });
  }

  try {
    const url = ESPN_FIELD_URL(eventId);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      next: { revalidate: 3600 }, // field doesn't change often
    });

    if (!res.ok) {
      // Fallback: try the leaderboard endpoint which also contains the full field
      const lbUrl = `https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga&event=${eventId}`;
      const lbRes = await fetch(lbUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (lbRes.ok) {
        const lbData = await lbRes.json();
        return NextResponse.json(lbData);
      }
      return NextResponse.json({ error: `ESPN responded with ${res.status}` }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error('ESPN field fetch error:', err);
    return NextResponse.json({ error: 'Failed to fetch ESPN field data' }, { status: 500 });
  }
}
