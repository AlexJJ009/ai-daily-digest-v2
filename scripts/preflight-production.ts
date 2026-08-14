import { validateProductionEnvironment } from '../src/delivery/preflight';

validateProductionEnvironment(process.env);
console.log('production configuration preflight ok');
