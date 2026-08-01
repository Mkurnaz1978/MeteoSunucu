const axios = require('axios');

async function test() {
  try {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=37.855&longitude=30.368&daily=sunrise,sunset,daylight_duration&forecast_days=1&timezone=UTC';
    const response = await axios.get(url, { timeout: 15000 });
    console.log('Daily data from API:');
    console.log(JSON.stringify(response.data.daily, null, 2));
    console.log('\nDaily Units:');
    console.log(JSON.stringify(response.data.daily_units, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
  }
}

test();
