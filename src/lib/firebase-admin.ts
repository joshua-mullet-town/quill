import { initializeApp, getApps, cert, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function init() {
	if (getApps().length) return;
	const credJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
	if (credJson) {
		initializeApp({ credential: cert(JSON.parse(credJson)) });
	} else {
		initializeApp({ credential: applicationDefault() });
	}
}

init();

export const db = getFirestore();
