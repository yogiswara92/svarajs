import 'dotenv/config';
import { SvaraApp, SvaraAgent, createTool } from '@yesvara/svara';

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get current weather for a city',
  parameters: {
    city: {
      type: 'string',
      description: 'City name',
      required: true,
    },
    units: {
      type: 'string',
      description: 'Temperature units: metric or imperial',
      enum: ['metric', 'imperial'],
    },
  },
  async run({ city, units = 'metric' }) {
    const apiKey = process.env.WEATHER_API_KEY;
    if (!apiKey) throw new Error('WEATHER_API_KEY not set');

    const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&units=${units}&appid=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json() as any;

    if (!res.ok) {
      throw new Error(data.message || 'Weather API error');
    }

    return {
      city: data.name,
      temp: data.main.temp,
      feels_like: data.main.feels_like,
      humidity: data.main.humidity,
      condition: data.weather[0].main,
      description: data.weather[0].description,
      wind_speed: data.wind.speed,
    };
  },
});

const agent = new SvaraAgent({
  name: 'Weather Bot',
  model: 'gpt-4o-mini',
  systemPrompt: 'You are a helpful weather assistant. Use get_weather tool to fetch weather data.',
  tools: [weatherTool],
});

agent.on('tool:call', ({ tools }) => {
  console.log(`🔧 Tools: ${tools.join(', ')}`);
});

const app = new SvaraApp({ cors: true });
app.route('/chat', agent.handler());
app.listen(3000);

console.log('✓ Weather Bot running on http://localhost:3000');
