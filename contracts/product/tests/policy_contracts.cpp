#include <splatview_product/policy.hpp>
#include "product_adapter.hpp"
#include <splatview_product/measurement_request.hpp>
#include <fstream>
#include <iostream>
#include <limits>

int main(int argc, char **argv) {
    try {
        using namespace splatview::product;
        if (argc != 2)
            throw std::runtime_error("Pass the shared availability fixture");
        std::ifstream input(argv[1]);
        const auto cases = nlohmann::json::parse(input);
        for (const auto &test : cases) {
            if (test.contains("binding")) {
                if (test.at("platform").get<std::string>() == localPlatform &&
                    registeredAllowed(test.at("binding").get<std::string>(),
                                      test.at("surface").get<std::string>(),
                                      test.at("host").get<std::string>()) != test.at("allowed").get<bool>())
                    throw std::runtime_error("Contextual binding mismatch: " + test.dump());
                continue;
            }
            if (allowed(test.at("feature").get<std::string>(), test.at("platform").get<std::string>(),
                        test.at("profile").get<std::string>(), test.at("surface").get<std::string>(),
                        test.at("host").get<std::string>(),
                        test.at("capabilities").get<std::string>()) != test.at("allowed").get<bool>())
                throw std::runtime_error("Availability mismatch: " + test.dump());
        }
        const std::array<MeasurementPoint, 2> distance{{{0, 0, 0}, {3, 4, 0}}};
        if (measure(MeasurementKind::Distance, distance) != 5)
            throw std::runtime_error("Distance is not five meters");
        const std::array<MeasurementPoint, 3> angle{{{1, 0, 0}, {0, 0, 0}, {0, 1, 0}}};
        if (std::abs(measure(MeasurementKind::Angle, angle) - 90) > 1e-10)
            throw std::runtime_error("Angle is not ninety degrees");
        for (const auto &invalid :
             {std::array<MeasurementPoint, 2>{{{0, 0, 0}, {std::numeric_limits<double>::infinity(), 0, 0}}},
              std::array<MeasurementPoint, 2>{{{-std::numeric_limits<double>::max(), 0, 0},
                                               {std::numeric_limits<double>::max(), 0, 0}}}}) {
            bool rejected = false;
            try {
                (void)measure(MeasurementKind::Distance, invalid);
            } catch (const std::invalid_argument &) {
                rejected = true;
            }
            if (!rejected)
                throw std::runtime_error("Nonfinite/out-of-range measurement accepted");
        }
        std::cout << "PASS " << cases.size() << " shared policy cases and measurement quantities\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "FAIL " << error.what() << '\n';
        return 1;
    }
}
