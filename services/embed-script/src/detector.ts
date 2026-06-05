export class BotDetector {
    private score: number = 0;
    
    constructor() {
        this.trackMouse();
        this.checkEnvironment();
    }

    private trackMouse() {
        let moves = 0;
        window.addEventListener('mousemove', () => {
            moves++;
            if (moves > 10) {
                // Humans move mouse non-linearly
                this.score -= 10;
            }
        }, { once: false });
    }

    private checkEnvironment() {
        // Headless browser detection heuristics
        if (navigator.webdriver) {
            this.score += 50;
        }
        
        // Missing languages or weird user agent
        if (!navigator.languages || navigator.languages.length === 0) {
            this.score += 20;
        }

        const ua = navigator.userAgent.toLowerCase();
        if (ua.includes('bot') || ua.includes('headless') || ua.includes('spider')) {
            this.score += 100; // Definite bot
        }
    }

    public isBot(): boolean {
        return this.score >= 50;
    }
}
