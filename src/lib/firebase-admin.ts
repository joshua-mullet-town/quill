import { initializeApp, getApps, cert, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function init() {
	if (getApps().length) return;
	const credJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
	const projectId =
		process.env.GOOGLE_CLOUD_PROJECT ||
		process.env.GCLOUD_PROJECT ||
		"quill-print";
	if (credJson) {
		initializeApp({ credential: cert(JSON.parse(credJson)), projectId });
	} else {
		initializeApp({ credential: applicationDefault(), projectId });
	}
}

init();

export const db = getFirestore();
