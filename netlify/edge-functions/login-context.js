export default async function loginContext(request, context) {
    if (request.method === 'OPTIONS') {
        return new Response('', {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            }
        });
    }

    if (request.method !== 'GET') {
        return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json; charset=UTF-8' }
        });
    }

    const geo = context.geo || {};
    const country = geo.country || {};
    const subdivision = geo.subdivision || {};
    const payload = {
        success: true,
        data: {
            ip: context.ip || '',
            city: geo.city || '',
            regionCode: subdivision.code || '',
            regionName: subdivision.name || '',
            countryCode: country.code || '',
            countryName: country.name || '',
            timezone: geo.timezone || ''
        }
    };

    return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Cache-Control': 'no-store, max-age=0',
            'Access-Control-Allow-Origin': '*'
        }
    });
}
